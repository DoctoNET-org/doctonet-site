/**
 * DoctoNET — /api/search
 * Worker Cloudflare Pages — FHIR R4 Annuaire Santé v2
 *
 * Stratégie en 2 requêtes :
 *   1. Practitioner?family=NOM + _revinclude=PractitionerRole:practitioner
 *      → on récupère Practitioners + leurs PractitionerRoles (avec ref Organization)
 *
 *   2. Organization?_id=id1,id2,id3...
 *      → on récupère les Organizations pour avoir les adresses
 */

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const p   = url.searchParams;

  const nom      = (p.get("nom") || "").trim();
  const nextUrl  =  p.get("next") || "";
  const rawDebug =  p.get("_raw") === "1";
  const count    = 20;

  const BASE    = "https://gateway.api.esante.gouv.fr/fhir/v2";
  const headers = { "ESANTE-API-KEY": env.ESANTE_API_KEY, "Accept": "application/fhir+json" };

  if (!nom && !nextUrl) {
    return jsonResponse({ error: "Paramètre 'nom' requis." }, 400);
  }

  try {
    // ── Étape 1 : Practitioner + PractitionerRole ────────────────────────
    let fhirUrl;
    if (nextUrl) {
      fhirUrl = nextUrl;
    } else {
      const fp = new URLSearchParams();
      fp.set("_count", String(count));
      fp.set("active", "true");
      fp.set("family", nom);
      fp.append("_revinclude", "PractitionerRole:practitioner");
      fhirUrl = `${BASE}/Practitioner?${fp}`;
    }

    const resp1 = await fetch(fhirUrl, { headers });
    if (!resp1.ok) {
      const detail = await resp1.text();
      return jsonResponse({ error: "FHIR error", status: resp1.status, detail, _url: fhirUrl }, resp1.status);
    }

    const bundle1 = await resp1.json();
    const nextLink = (bundle1.link || []).find((l) => l.relation === "next")?.url || null;

    // Indexation Practitioner + PractitionerRole
    const practitioners = {};
    const roles = {};   // practId → PractitionerRole
    const orgIds = new Set();

    for (const entry of (bundle1.entry || [])) {
      const res = entry.resource;
      if (!res) continue;
      if (res.resourceType === "Practitioner") {
        practitioners[res.id] = res;
      } else if (res.resourceType === "PractitionerRole") {
        const practId = (res.practitioner?.reference || "").split("/").pop();
        if (practId && !roles[practId]) {
          roles[practId] = res;
          // Collecte les IDs d'organisation
          const orgId = (res.organization?.reference || "").split("/").pop();
          if (orgId) orgIds.add(orgId);
        }
      }
    }

    if (rawDebug) return jsonResponse({ _url: fhirUrl, _bundle1: bundle1, orgIds: [...orgIds] });

    // ── Étape 2 : Organizations pour les adresses ────────────────────────
    const orgs = {};
    if (orgIds.size > 0) {
      const fp2 = new URLSearchParams();
      fp2.set("_id", [...orgIds].join(","));
      fp2.set("_count", "100");
      const orgUrl = `${BASE}/Organization?${fp2}`;

      const resp2 = await fetch(orgUrl, { headers });
      if (resp2.ok) {
        const bundle2 = await resp2.json();
        for (const entry of (bundle2.entry || [])) {
          const res = entry.resource;
          if (res?.resourceType === "Organization") {
            orgs[res.id] = res;
          }
        }
      }
    }

    // ── Transformation ───────────────────────────────────────────────────
    const results = Object.values(practitioners).map((pract) => {
      const role  = roles[pract.id] || null;
      const orgId = (role?.organization?.reference || "").split("/").pop();
      const org   = orgs[orgId] || null;

      const adresse = extractAdresse(role, org);
      const telecom = extractTelecom(role, org);

      return {
        id:         pract.id,
        nom:        extractNom(pract),
        specialite: extractSpecialite(role),
        adresse:    adresse?.texte      || "",
        codePostal: adresse?.codePostal || "",
        ville:      adresse?.ville      || "",
        telephone:  telecom.telephone,
        email:      telecom.email,
      };
    });

    return jsonResponse({
      total:   bundle1.total ?? results.length,
      count:   results.length,
      nextUrl: nextLink,
      results,
      _meta: {
        url:        fhirUrl,
        practFound: Object.keys(practitioners).length,
        rolesFound: Object.keys(roles).length,
        orgsFound:  Object.keys(orgs).length,
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
  return role?.specialty?.[0]?.coding?.[0]?.display
      || role?.code?.[0]?.coding?.[0]?.display
      || "";
}

function extractAdresse(role, org) {
  // 1. Adresse dans l'Organisation
  const orgAddr = (org?.address || [])[0];
  if (orgAddr) return parseAddress(orgAddr);
  // 2. Adresse directe dans le rôle
  const roleAddr = (role?.address || [])[0];
  if (roleAddr) return parseAddress(roleAddr);
  // 3. Extension valueAddress
  for (const ext of (role?.extension || [])) {
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

function extractTelecom(role, org) {
  const t = [...(role?.telecom || []), ...(org?.telecom || [])];
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
