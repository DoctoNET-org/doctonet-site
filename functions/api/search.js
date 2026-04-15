/**
 * DoctoNET — /api/search
 * Worker Cloudflare Pages — FHIR R4 Annuaire Santé v2
 *
 * L'API retourne un Bundle contenant :
 *   - entry[].resource de type "PractitionerRole"  → spécialité, adresse, téléphone
 *   - entry[].resource de type "Practitioner"      → nom (via _include)
 *   - entry[].resource de type "Location"          → adresse GPS (via _include:iterate)
 *
 * Paramètres supportés par l'API ANS sur PractitionerRole :
 *   - near          : lat|lng|rayon|km  (géolocalisation)
 *   - specialty     : code spécialité
 *   - practitioner.name : nom du praticien
 *   NB : location.address-city n'est PAS supporté → on filtre côté serveur si besoin
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
  const count      = 20;
  const offset     = (page - 1) * count;

  // --- Construction de la requête FHIR ---
  const fhirParams = new URLSearchParams();
  fhirParams.set("_count",  String(count));
  fhirParams.set("_offset", String(offset));
  fhirParams.set("active",  "true");

  // Inclure Practitioner (nom) et Location (adresse GPS)
  fhirParams.append("_include", "PractitionerRole:practitioner");
  fhirParams.append("_include", "PractitionerRole:location");

  // Géolocalisation (paramètre natif FHIR)
  if (lat && lng) {
    fhirParams.set("near", `${lat}|${lng}|${km}|km`);
  }

  // Spécialité
  if (specialite) {
    fhirParams.set("specialty", specialite);
  }

  // Nom du praticien
  if (nom) {
    fhirParams.set("practitioner.name", nom);
  }

  // NB : on ne filtre PAS par ville via FHIR (non supporté) → filtrage JS post-traitement
  const FHIR_BASE = "https://gateway.api.esante.gouv.fr/fhir/v1";
  const fhirUrl   = `${FHIR_BASE}/PractitionerRole?${fhirParams.toString()}`;

  try {
    const resp = await fetch(fhirUrl, {
      headers: {
        "ESANTE-API-KEY": env.ESANTE_API_KEY,
        "Accept":         "application/fhir+json",
      },
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return jsonResponse({ error: "FHIR error", status: resp.status, detail: errText }, resp.status);
    }

    const bundle = await resp.json();
    const entries = bundle.entry || [];

    // --- Indexation des ressources incluses ---
    const practitioners = {};
    const locations     = {};
    const roles         = [];

    for (const entry of entries) {
      const res = entry.resource;
      if (!res) continue;
      switch (res.resourceType) {
        case "Practitioner":     practitioners[res.id] = res; break;
        case "Location":         locations[res.id]     = res; break;
        case "PractitionerRole": roles.push(res);             break;
      }
    }

    // --- Transformation ---
    let results = roles.map((role) => {
      const practId = (role.practitioner?.reference || "").split("/").pop();
      const pract   = practitioners[practId] || null;
      const adresse = extractAdresse(role, locations);
      const telecom = extractTelecom(role);

      return {
        id:          role.id,
        nom:         extractNom(pract),
        specialite:  extractSpecialite(role),
        adresse:     adresse?.texte      || "",
        codePostal:  adresse?.codePostal || "",
        ville:       adresse?.ville      || "",
        pays:        adresse?.pays       || "France",
        telephone:   telecom.telephone,
        email:       telecom.email,
        distance:    (lat && lng && adresse?.lat && adresse?.lng)
                       ? haversine(lat, lng, adresse.lat, adresse.lng)
                       : null,
        latitude:    adresse?.lat ?? null,
        longitude:   adresse?.lng ?? null,
      };
    });

    // Filtrage ville côté JS (l'API ne supporte pas location.address-city)
    if (ville) {
      results = results.filter((r) =>
        r.ville.toUpperCase().includes(ville) ||
        r.codePostal.startsWith(ville)
      );
    }

    return jsonResponse({
      total:   bundle.total ?? results.length,
      page,
      count:   results.length,
      results,
    });

  } catch (err) {
    return jsonResponse({ error: "Internal error", detail: err.message }, 500);
  }
}

// ─── Helpers de parsing FHIR ────────────────────────────────────────────────

function extractNom(pract) {
  if (!pract) return "Nom inconnu";
  const names = pract.name || [];
  const hn    = names.find((n) => n.use === "official") || names[0];
  if (!hn) return "Nom inconnu";
  const prefix = (hn.prefix || []).join(" ");
  const given  = (hn.given  || []).join(" ");
  const family = hn.family  || "";
  return [prefix, given, family].filter(Boolean).join(" ").trim() || "Nom inconnu";
}

function extractSpecialite(role) {
  try { return role.specialty?.[0]?.coding?.[0]?.display || ""; }
  catch { return ""; }
}

function extractAdresse(role, locations) {
  // 1. Via Location incluse
  for (const locRef of (role.location || [])) {
    const locId = (locRef.reference || "").split("/").pop();
    const loc   = locations[locId];
    if (loc?.address) return parseAddress(loc.address, loc.position);
  }
  // 2. Via extension
  for (const ext of (role.extension || [])) {
    if (ext.valueAddress) return parseAddress(ext.valueAddress, null);
    for (const sub of (ext.extension || [])) {
      if (sub.valueAddress) return parseAddress(sub.valueAddress, null);
    }
  }
  // 3. Adresse directe
  const direct = (role.address || [])[0];
  if (direct) return parseAddress(direct, null);
  return null;
}

function parseAddress(addr, position) {
  if (!addr) return null;
  const ligne1     = (addr.line || [])[0] || "";
  const codePostal = addr.postalCode || "";
  const ville      = addr.city       || "";
  const pays       = addr.country    || "France";
  const parts      = [
    ligne1,
    codePostal && ville ? `${codePostal} ${ville}` : (ville || codePostal),
    pays !== "France" ? pays : "",
  ].filter(Boolean);
  return { texte: parts.join(", "), codePostal, ville, pays,
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
  const R = 6371;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLng/2)**2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)) * 10) / 10;
}
function rad(deg) { return (deg * Math.PI) / 180; }

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
