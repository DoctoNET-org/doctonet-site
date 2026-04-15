/**
 * DoctoNET — /api/search
 * Worker Cloudflare Pages — FHIR R4 Annuaire Santé v2
 *
 * Stratégie : on interroge Practitioner (qui marche) avec _revinclude
 * pour récupérer les PractitionerRole associés (qui contiennent adresse + téléphone).
 *
 * Paramètres confirmés sur Practitioner :
 *   - name, family, given
 *   - _revinclude=PractitionerRole:practitioner  → roles liés
 *   - _include via PractitionerRole:location     → locations liées
 *
 * Si géoloc : on interroge d'abord par near sur PractitionerRole seul
 * puis on hydrate les Practitioner depuis les refs.
 */

export async function onRequestGet({ request, env }) {
  const url    = new URL(request.url);
  const params = url.searchParams;

  const nom        = params.get("nom")        || "";
  const ville      = (params.get("ville")     || "").trim().toUpperCase();
  const specialite = params.get("specialite") || "";
  const lat        = parseFloat(params.get("lat") || "0");
  const lng        = parseFloat(params.get("lon") || params.get("lng") || "0");
  const km         = parseInt(params.get("km")    || "20", 10);
  const page       = parseInt(params.get("page")  || "1",  10);
  const rawDebug   = params.get("_raw") === "1";
  const count      = 20;
  const offset     = (page - 1) * count;

  const FHIR_BASE = "https://gateway.api.esante.gouv.fr/fhir/v1";
  const headers   = {
    "ESANTE-API-KEY": env.ESANTE_API_KEY,
    "Accept":         "application/fhir+json",
  };

  try {
    let bundle;

    if (lat && lng) {
      // ── Cas géoloc : PractitionerRole?near + _include:practitioner + _include:location ──
      // On teste d'abord sans _include pour voir si near marche seul
      const fp = new URLSearchParams({
        _count:  String(count),
        _offset: String(offset),
        active:  "true",
        near:    `${lat}|${lng}|${km}|km`,
      });
      if (specialite) fp.set("specialty", specialite);
      // On ajoute les includes séparément (certains serveurs n'aiment pas les doublons)
      const fhirUrl = `${FHIR_BASE}/PractitionerRole?${fp}&_include=PractitionerRole%3Apractitioner&_include=PractitionerRole%3Alocation`;

      const resp = await fetch(fhirUrl, { headers });
      if (!resp.ok) {
        const detail = await resp.text();
        // Fallback : si near+_include échoue, essayer sans _include
        if (resp.status === 400) {
          const fp2 = new URLSearchParams({
            _count:  String(count),
            _offset: String(offset),
            active:  "true",
            near:    `${lat}|${lng}|${km}|km`,
          });
          if (specialite) fp2.set("specialty", specialite);
          const resp2 = await fetch(`${FHIR_BASE}/PractitionerRole?${fp2}`, { headers });
          if (!resp2.ok) {
            return jsonResponse({ error: "FHIR error", status: resp2.status, detail: await resp2.text() }, resp2.status);
          }
          bundle = await resp2.json();
        } else {
          return jsonResponse({ error: "FHIR error", status: resp.status, detail }, resp.status);
        }
      } else {
        bundle = await resp.json();
      }

    } else {
      // ── Cas recherche par nom / ville ──
      // On interroge Practitioner avec _revinclude pour avoir les rôles
      const fp = new URLSearchParams({
        _count:  String(count),
        _offset: String(offset),
        active:  "true",
        "_revinclude": "PractitionerRole:practitioner",
      });
      if (nom)  fp.set("family", nom);
      if (ville) fp.set("address-city", ville);

      const fhirUrl = `${FHIR_BASE}/Practitioner?${fp}`;
      const resp    = await fetch(fhirUrl, { headers });
      if (!resp.ok) {
        return jsonResponse({ error: "FHIR error", status: resp.status, detail: await resp.text() }, resp.status);
      }
      bundle = await resp.json();
    }

    // Debug : retourner le bundle brut
    if (rawDebug) {
      return jsonResponse({ _raw: bundle });
    }

    // ── Indexation ──
    const practitioners = {};
    const locations     = {};
    const roles         = [];

    for (const entry of (bundle.entry || [])) {
      const res = entry.resource;
      if (!res) continue;
      switch (res.resourceType) {
        case "Practitioner":     practitioners[res.id] = res; break;
        case "Location":         locations[res.id]     = res; break;
        case "PractitionerRole": roles.push(res);             break;
      }
    }

    // ── Transformation ──
    let results = roles.map((role) => {
      const practId = (role.practitioner?.reference || "").split("/").pop();
      const pract   = practitioners[practId] || null;
      const adresse = extractAdresse(role, locations);
      const telecom = extractTelecom(role);

      return {
        id:         role.id,
        nom:        extractNom(pract),
        specialite: extractSpecialite(role),
        adresse:    adresse?.texte      || "",
        codePostal: adresse?.codePostal || "",
        ville:      adresse?.ville      || "",
        pays:       adresse?.pays       || "France",
        telephone:  telecom.telephone,
        email:      telecom.email,
        distance:   (lat && lng && adresse?.lat && adresse?.lng)
                      ? haversine(lat, lng, adresse.lat, adresse.lng)
                      : null,
        latitude:   adresse?.lat ?? null,
        longitude:  adresse?.lng ?? null,
      };
    });

    // Si pas de rôles mais des Practitioners (cas _revinclude vide), on affiche quand même les praticiens
    if (roles.length === 0 && Object.keys(practitioners).length > 0) {
      results = Object.values(practitioners).map((pract) => ({
        id:         pract.id,
        nom:        extractNom(pract),
        specialite: "",
        adresse: "", codePostal: "", ville: "", pays: "France",
        telephone: "", email: "", distance: null, latitude: null, longitude: null,
      }));
    }

    if (ville && roles.length > 0) {
      results = results.filter((r) =>
        r.ville.toUpperCase().includes(ville) || r.codePostal.startsWith(ville)
      );
    }

    return jsonResponse({
      total:   bundle.total ?? results.length,
      page,
      count:   results.length,
      results,
      _meta: { rolesFound: roles.length, practFound: Object.keys(practitioners).length, locFound: Object.keys(locations).length },
    });

  } catch (err) {
    return jsonResponse({ error: "Internal error", detail: err.message }, 500);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractNom(pract) {
  if (!pract) return "Nom inconnu";
  const hn = (pract.name || []).find((n) => n.use === "official") || (pract.name || [])[0];
  if (!hn) return "Nom inconnu";
  return [[...(hn.prefix||[]), ...(hn.given||[]), hn.family||""].join(" ")].join("").trim() || "Nom inconnu";
}

function extractSpecialite(role) {
  return role.specialty?.[0]?.coding?.[0]?.display || "";
}

function extractAdresse(role, locations) {
  for (const locRef of (role.location || [])) {
    const loc = locations[(locRef.reference || "").split("/").pop()];
    if (loc?.address) return parseAddress(loc.address, loc.position);
  }
  for (const ext of (role.extension || [])) {
    if (ext.valueAddress) return parseAddress(ext.valueAddress, null);
    for (const sub of (ext.extension || [])) {
      if (sub.valueAddress) return parseAddress(sub.valueAddress, null);
    }
  }
  const direct = (role.address || [])[0];
  if (direct) return parseAddress(direct, null);
  return null;
}

function parseAddress(addr, position) {
  if (!addr) return null;
  const ligne1 = (addr.line || [])[0] || "";
  const cp     = addr.postalCode || "";
  const ville  = addr.city       || "";
  const pays   = addr.country    || "France";
  const parts  = [ligne1, cp && ville ? `${cp} ${ville}` : (ville || cp), pays !== "France" ? pays : ""].filter(Boolean);
  return { texte: parts.join(", "), codePostal: cp, ville, pays, lat: position?.latitude ?? null, lng: position?.longitude ?? null };
}

function extractTelecom(role) {
  const t = role.telecom || [];
  return { telephone: t.find((x) => x.system === "phone")?.value || "", email: t.find((x) => x.system === "email")?.value || "" };
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371, dLat = rad(lat2-lat1), dLng = rad(lng2-lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLng/2)**2;
  return Math.round(2*R*Math.asin(Math.sqrt(a))*10)/10;
}
function rad(d) { return d*Math.PI/180; }

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
