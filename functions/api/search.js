/**
 * DoctoNET — /api/search
 * Worker Cloudflare Pages — FHIR R4 Annuaire Santé v2
 *
 * Endpoint : https://gateway.api.esante.gouv.fr/fhir/v2/
 *
 * Paramètres supportés sur PractitionerRole :
 *   - near=lat|lng|km|km
 *   - _count
 *   - _include=PractitionerRole:practitioner
 *   - _include=PractitionerRole:location
 *   - specialty
 *   - active
 *   NB: ni _offset ni _page ne sont supportés → on utilise les liens "next" du bundle
 */

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const p   = url.searchParams;

  const nom        = p.get("nom")        || "";
  const ville      = (p.get("ville")     || "").trim().toUpperCase();
  const specialite = p.get("specialite") || "";
  const lat        = parseFloat(p.get("lat") || "0");
  const lng        = parseFloat(p.get("lon") || p.get("lng") || "0");
  const km         = parseInt(p.get("km")    || "20", 10);
  const nextUrl    = p.get("next")       || "";   // lien de pagination fourni par le bundle
  const rawDebug   = p.get("_raw") === "1";
  const count      = 20;

  const BASE    = "https://gateway.api.esante.gouv.fr/fhir/v2";
  const headers = { "ESANTE-API-KEY": env.ESANTE_API_KEY, "Accept": "application/fhir+json" };

  try {
    let fhirUrl;

    if (nextUrl) {
      // ── Pagination : on suit le lien "next" fourni par le bundle précédent ──
      fhirUrl = nextUrl;

    } else if (lat && lng) {
      // ── Géoloc via PractitionerRole?near ─────────────────────────────────
      const fp = new URLSearchParams();
      fp.set("_count", String(count));
      fp.set("active", "true");
      fp.set("near",   `${lat}|${lng}|${km}|km`);
      fp.append("_include", "PractitionerRole:practitioner");
      fp.append("_include", "PractitionerRole:location");
      if (specialite) fp.set("specialty", specialite);
      fhirUrl = `${BASE}/PractitionerRole?${fp}`;

    } else {
      // ── Par nom / ville via Practitioner ─────────────────────────────────
      const fp = new URLSearchParams();
      fp.set("_count", String(count));
      fp.set("active", "true");
      fp.append("_revinclude", "PractitionerRole:practitioner");
      if (nom)   fp.set("family",       nom);
      if (ville) fp.set("address-city", ville);
      fhirUrl = `${BASE}/Practitioner?${fp}`;
    }

    const resp = await fetch(fhirUrl, { headers });

    if (!resp.ok) {
      const detail = await resp.text();
      return jsonResponse({ error: "FHIR error", status: resp.status, detail, _url: fhirUrl }, resp.status);
    }

    const bundle = await resp.json();
    if (rawDebug) return jsonResponse({ _url: fhirUrl, _raw: bundle });

    // ── Lien de page suivante (relation "next" dans bundle.link) ─────────
    const nextLink = (bundle.link || []).find((l) => l.relation === "next")?.url || null;

    // ── Indexation ────────────────────────────────────────────────────────
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

    // ── Transformation ────────────────────────────────────────────────────
    let results = roles.map((role) => {
      const practId = (role.practitioner?.reference || "").split("/").pop();
      const locId   = (role.location?.[0]?.reference || "").split("/").pop();
      const pract   = practitioners[practId] || null;
      const loc     = locations[locId]       || null;
      const adresse = extractAdresse(role, loc);
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

    // Filtrage ville côté JS (sans géoloc)
    if (ville && !lat) {
      results = results.filter((r) =>
        r.ville.toUpperCase().includes(ville) || r.codePostal.startsWith(ville)
      );
    }

    return jsonResponse({
      total:    bundle.total ?? results.length,
      count:    results.length,
      nextUrl:  nextLink,   // à passer en paramètre ?next= pour la page suivante
      results,
      _meta: {
        url:        fhirUrl,
        rolesFound: roles.length,
        practFound: Object.keys(practitioners).length,
        locFound:   Object.keys(locations).length,
      },
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
  return [...(hn.prefix || []), ...(hn.given || []), hn.family || ""]
    .filter(Boolean).join(" ").trim() || "Nom inconnu";
}

function extractSpecialite(role) {
  return role.specialty?.[0]?.coding?.[0]?.display || "";
}

function extractAdresse(role, loc) {
  if (loc?.address) return parseAddress(loc.address, loc.position);
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
  const parts  = [
    ligne1,
    cp && ville ? `${cp} ${ville}` : (ville || cp),
    pays !== "France" ? pays : "",
  ].filter(Boolean);
  return { texte: parts.join(", "), codePostal: cp, ville, pays,
           lat: position?.latitude ?? null, lng: position?.longitude ?? null };
}

function extractTelecom(role) {
  const t = role.telecom || [];
  return {
    telephone: t.find((x) => x.system === "phone")?.value || "",
    email:     t.find((x) => x.system === "email")?.value || "",
  };
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
