/**
 * DoctoNET — /api/search
 * Worker Cloudflare Pages — FHIR R4 Annuaire Santé v2
 *
 * L'API retourne un Bundle contenant :
 *   - entry[].resource de type "Practitioner"         → nom, identifiants
 *   - entry[].resource de type "PractitionerRole"     → spécialité, adresse, téléphone, lien vers Practitioner
 *   - entry[].resource de type "Organization"         → nom de l'établissement (optionnel)
 *
 * Les adresses et téléphones se trouvent dans PractitionerRole.availableTime,
 * PractitionerRole.telecom et PractitionerRole.location → Location.address
 * OU directement dans PractitionerRole.extension (selon le profil ANS).
 *
 * Pour l'Annuaire Santé v2, l'adresse est le plus souvent dans :
 *   PractitionerRole.extension[url="https://apifhir.annuaire.sante.fr/ws-sync/exposed/structuredefinition/practitionerRole-locationReference"]
 * ou dans les ressources Location incluses via _include.
 *
 * On utilise _include=PractitionerRole:practitioner pour lier les deux.
 */

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const params = url.searchParams;

  const nom        = params.get("nom")        || "";
  const ville      = params.get("ville")      || "";
  const specialite = params.get("specialite") || "";
  const lat        = parseFloat(params.get("lat")  || "0");
  const lng        = parseFloat(params.get("lng")  || "0");
  const page       = parseInt(params.get("page")   || "1", 10);
  const count      = 20;
  const offset     = (page - 1) * count;

  // --- Construction de la requête FHIR ---
  // On interroge PractitionerRole (qui contient adresse + téléphone)
  // et on inclut la ressource Practitioner liée pour le nom.
  const fhirParams = new URLSearchParams();
  fhirParams.set("_count",  String(count));
  fhirParams.set("_offset", String(offset));
  fhirParams.set("_include", "PractitionerRole:practitioner");
  fhirParams.set("_include:iterate", "PractitionerRole:location"); // pour avoir l'adresse via Location si besoin
  fhirParams.set("active", "true");

  if (nom)        fhirParams.set("practitioner.name", nom);
  if (specialite) fhirParams.set("specialty",         specialite);

  // Géolocalisation : near=lat|lng|rayon|unité
  if (lat && lng) {
    fhirParams.set("near", `${lat}|${lng}|50|km`);
  }

  // Ville : on cherche dans l'adresse du PractitionerRole
  if (ville) {
    fhirParams.set("location.address-city", ville.toUpperCase());
  }

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
    // On sépare PractitionerRole, Practitioner et Location
    const practitioners = {};  // id → resource
    const locations     = {};  // id → resource
    const roles         = [];

    for (const entry of entries) {
      const res = entry.resource;
      if (!res) continue;

      switch (res.resourceType) {
        case "Practitioner":
          practitioners[res.id] = res;
          break;
        case "Location":
          locations[res.id] = res;
          break;
        case "PractitionerRole":
          roles.push(res);
          break;
        default:
          break;
      }
    }

    // --- Transformation en résultats propres ---
    const results = roles.map((role) => {
      // 1. Lien vers Practitioner
      const practRef  = role.practitioner?.reference || "";       // ex: "Practitioner/003-123456"
      const practId   = practRef.split("/").pop();
      const pract     = practitioners[practId] || null;

      // 2. Nom
      const nom = extractNom(pract);

      // 3. Spécialité
      const specialite = extractSpecialite(role);

      // 4. Adresse — cherchée dans cet ordre :
      //    a) role.extension location embedded
      //    b) ressource Location incluse via _include
      //    c) champ address directement dans PractitionerRole (profils anciens)
      const adresse = extractAdresse(role, locations);

      // 5. Téléphone / email
      const { telephone, email } = extractTelecom(role);

      // 6. Distance (si géoloc disponible)
      const distance = (lat && lng && adresse?.lat && adresse?.lng)
        ? haversine(lat, lng, adresse.lat, adresse.lng)
        : null;

      return {
        id:          role.id,
        nom,
        specialite,
        adresse:     adresse?.texte      || "",
        codePostal:  adresse?.codePostal || "",
        ville:       adresse?.ville      || "",
        pays:        adresse?.pays       || "France",
        telephone,
        email,
        distance,          // en km, arrondi à 1 décimale — null si non dispo
        latitude:    adresse?.lat ?? null,
        longitude:   adresse?.lng ?? null,
      };
    });

    const total = bundle.total ?? results.length;

    return jsonResponse({
      total,
      page,
      count: results.length,
      results,
    });

  } catch (err) {
    return jsonResponse({ error: "Internal error", detail: err.message }, 500);
  }
}

// ─── Helpers de parsing FHIR ────────────────────────────────────────────────

/**
 * Extrait le nom complet depuis une ressource Practitioner.
 * HumanName FHIR : name[].family + name[].given[]
 */
function extractNom(pract) {
  if (!pract) return "Nom inconnu";

  const names = pract.name || [];
  // On préfère le nom "official", sinon le premier
  const hn = names.find((n) => n.use === "official") || names[0];
  if (!hn) return "Nom inconnu";

  const prefix = (hn.prefix || []).join(" ");
  const given  = (hn.given  || []).join(" ");
  const family = hn.family  || "";

  return [prefix, given, family].filter(Boolean).join(" ").trim() || "Nom inconnu";
}

/**
 * Extrait la spécialité depuis PractitionerRole.specialty[].coding[].display
 */
function extractSpecialite(role) {
  try {
    return role.specialty?.[0]?.coding?.[0]?.display || "";
  } catch {
    return "";
  }
}

/**
 * Extrait l'adresse complète.
 *
 * Stratégie (ordre de priorité) :
 *  1. role.location[] → cherche dans locations indexées
 *  2. role.extension[] contenant une Address
 *  3. Champ role.address[] (peu utilisé dans l'Annuaire Santé v2 mais possible)
 */
function extractAdresse(role, locations) {
  // 1. Via Location incluse
  const locationRefs = role.location || [];
  for (const locRef of locationRefs) {
    const locId = (locRef.reference || "").split("/").pop();
    const loc   = locations[locId];
    if (loc?.address) {
      return parseAddress(loc.address, loc.position);
    }
  }

  // 2. Via extension (profil ANS — certaines versions embarquent l'adresse ici)
  const extensions = role.extension || [];
  for (const ext of extensions) {
    if (ext.valueAddress) {
      return parseAddress(ext.valueAddress, null);
    }
    // Extension imbriquée
    for (const sub of ext.extension || []) {
      if (sub.valueAddress) {
        return parseAddress(sub.valueAddress, null);
      }
    }
  }

  // 3. Champ address directement dans le rôle
  const directAddress = (role.address || [])[0];
  if (directAddress) {
    return parseAddress(directAddress, null);
  }

  return null;
}

/**
 * Normalise un objet Address FHIR en objet métier.
 * position : { latitude, longitude } optionnel (depuis Location)
 */
function parseAddress(addr, position) {
  if (!addr) return null;

  // line[] peut contenir plusieurs lignes (numéro + rue, complément…)
  const lignes     = addr.line || [];
  const ligne1     = lignes[0] || "";
  const codePostal = addr.postalCode || "";
  const ville      = addr.city       || "";
  const pays       = addr.country    || "France";

  const parts = [ligne1, codePostal && ville ? `${codePostal} ${ville}` : ville || codePostal, pays !== "France" ? pays : ""].filter(Boolean);
  const texte  = parts.join(", ");

  return {
    texte,
    codePostal,
    ville,
    pays,
    lat: position?.latitude  ?? null,
    lng: position?.longitude ?? null,
  };
}

/**
 * Extrait téléphone et email depuis PractitionerRole.telecom[]
 * system : "phone" | "fax" | "email" | "url"
 */
function extractTelecom(role) {
  const telecoms  = role.telecom || [];
  const telephone = telecoms.find((t) => t.system === "phone")?.value || "";
  const email     = telecoms.find((t) => t.system === "email")?.value || "";
  return { telephone, email };
}

/**
 * Calcul de distance Haversine (km) entre deux points GPS.
 */
function haversine(lat1, lng1, lat2, lng2) {
  const R  = 6371;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)) * 10) / 10;
}
function rad(deg) { return (deg * Math.PI) / 180; }

// ─── Utilitaire réponse JSON ─────────────────────────────────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type":                "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
