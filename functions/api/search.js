/**
 * DoctoNET — /api/search
 * Worker Cloudflare Pages — FHIR R4 Annuaire Santé v2
 *
 * Paramètres confirmés fonctionnels sur /fhir/v2/Practitioner :
 *   - family=NOM         → recherche par nom de famille
 *   - _revinclude=PractitionerRole:practitioner → rôles liés (adresse, tél, spécialité)
 *   - _count=N           → nombre de résultats
 *   - active=true        → praticiens actifs uniquement
 *
 * Pagination via bundle.link[rel=next]
 */

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const p   = url.searchParams;

  const nom     = (p.get("nom") || "").trim();
  const nextUrl =  p.get("next") || "";
  const rawDebug = p.get("_raw") === "1";
  const count   = 20;

  const BASE    = "https://gateway.api.esante.gouv.fr/fhir/v2";
  const headers = { "ESANTE-API-KEY": env.ESANTE_API_KEY, "Accept": "application/fhir+json" };

  if (!nom && !nextUrl) {
    return jsonResponse({ error: "Paramètre 'nom' requis." }, 400);
  }

  try {
    let fhirUrl;

    if (nextUrl) {
      fhirUrl = nextUrl;
    } else {
      const fp = new URLSearchParams();
      fp.set("_count",  String(count));
      fp.set("active",  "true");
      fp.set("family",  nom);
      fp.append("_revinclude", "PractitionerRole:practitioner");
      fhirUrl = `${BASE}/Practitioner?${fp}`;
    }

    const resp = await fetch(fhirUrl, { headers });

    if (!resp.ok) {
      const detail = await resp.text();
      return jsonResponse({ error: "FHIR error", status: resp.status, detail, _url: fhirUrl }, resp.status);
    }

    const bundle = await resp.json();
    if (rawDebug) return jsonResponse({ _url: fhirUrl, _raw: bundle });

    // Lien page suivante
    const nextLink = (bundle.link || []).find((l) => l.relation === "next")?.url || null;

    // Indexation
    const practitioners = {};
    const roles = {};

    for (const entry of (bundle.entry || [])) {
      const res = entry.resource;
      if (!res) continue;
      if (res.resourceType === "Practitioner") {
        practitioners[res.id] = res;
      } else if (res.resourceType === "PractitionerRole") {
        const practId = (res.practitioner?.reference || "").split("/").pop();
        if (practId && !roles[practId]) roles[practId] = res;
      }
    }

    // Transformation
    const results = Object.values(practitioners).map((pract) => {
      const role    = roles[pract.id] || null;
      const adresse = role ? extractAdresse(role) : null;
      const telecom = role ? extractTelecom(role) : { telephone: "", email: "" };

      return {
        id:         pract.id,
        nom:        extractNom(pract),
        specialite: role ? extractSpecialite(role) : "",
        adresse:    adresse?.texte      || "",
        codePostal: adresse?.codePostal || "",
        ville:      adresse?.ville      || "",
        telephone:  telecom.telephone,
        email:      telecom.email,
      };
    });

    return jsonResponse({
      total:   bundle.total ?? results.length,
      count:   results.length,
      nextUrl: nextLink,
      results,
      _meta: { url: fhirUrl, practFound: Object.keys(practitioners).length, rolesFound: Object.keys(roles).length },
    });

  } catch (err) {
    return jsonResponse({ error: "Internal error", detail: err.message }, 500);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractNom(pract) {
  if (!pract) return "Nom inconnu";
  const hn = (pract.name || []).find((n) => n.use === "official") || (pract.name || [])[0];
  if (!hn) return "Nom inconnu";
  return [...(hn.prefix || []), ...(hn.given || []), hn.family || ""].filter(Boolean).join(" ").trim() || "Nom inconnu";
}

function extractSpecialite(role) {
  return role.specialty?.[0]?.coding?.[0]?.display || role.code?.[0]?.coding?.[0]?.display || "";
}

function extractAdresse(role) {
  const direct = (role.address || [])[0];
  if (direct) return parseAddress(direct);
  for (const ext of (role.extension || [])) {
    if (ext.valueAddress) return parseAddress(ext.valueAddress);
    for (const sub of (ext.extension || [])) {
      if (sub.valueAddress) return parseAddress(sub.valueAddress);
    }
  }
  return null;
}

function parseAddress(addr) {
  if (!addr) return null;
  const ligne1 = (addr.line || [])[0] || "";
  const cp     = addr.postalCode || "";
  const ville  = addr.city || "";
  const parts  = [ligne1, cp && ville ? `${cp} ${ville}` : (ville || cp)].filter(Boolean);
  return { texte: parts.join(", "), codePostal: cp, ville };
}

function extractTelecom(role) {
  const t = role.telecom || [];
  return {
    telephone: t.find((x) => x.system === "phone")?.value || "",
    email:     t.find((x) => x.system === "email")?.value || "",
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
