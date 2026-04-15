/**
 * DoctoNET — /api/search
 * Worker Cloudflare Pages — FHIR R4 Annuaire Santé v2
 *
 * Chaîne confirmée :
 *   Practitioner?family=NOM
 *     &_revinclude=PractitionerRole:practitioner  → rôles (spécialité, telecom)
 *     &_include=PractitionerRole:organization      → organisation (adresse !)
 *
 * L'adresse est dans Organization, pas dans PractitionerRole ni Practitioner.
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
    let fhirUrl;

    if (nextUrl) {
      fhirUrl = nextUrl;
    } else {
      const fp = new URLSearchParams();
      fp.set("_count", String(count));
      fp.set("active", "true");
      fp.set("family", nom);
      fp.append("_revinclude", "PractitionerRole:practitioner");
      // On ajoute l'include de l'organisation pour avoir l'adresse
      fp.append("_include",    "PractitionerRole:organization");
      fhirUrl = `${BASE}/Practitioner?${fp}`;
    }

    const resp = await fetch(fhirUrl, { headers });

    if (!resp.ok) {
      const detail = await resp.text();
      return jsonResponse({ error: "FHIR error", status: resp.status, detail, _url: fhirUrl }, resp.status);
    }

    const bundle = await resp.json();
    if (rawDebug) return jsonResponse({ _url: fhirUrl, _raw: bundle });

    const nextLink = (bundle.link || []).find((l) => l.relation === "next")?.url || null;

    // ── Indexation ───────────────────────────────────────────────────────
    const practitioners = {};
    const roles         = {};   // practId → PractitionerRole
    const orgs          = {};   // orgId   → Organization

    for (const entry of (bundle.entry || [])) {
      const res = entry.resource;
      if (!res) continue;
      switch (res.resourceType) {
        case "Practitioner":
          practitioners[res.id] = res;
          break;
        case "PractitionerRole": {
          const practId = (res.practitioner?.reference || "").split("/").pop();
          if (practId && !roles[practId]) roles[practId] = res;
          break;
        }
        case "Organization":
          orgs[res.id] = res;
          break;
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
      total:   bundle.total ?? results.length,
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
  // 1. Depuis l'Organisation (contient l'adresse du cabinet)
  const orgAddr = (org?.address || [])[0];
  if (orgAddr) return parseAddress(orgAddr);

  // 2. Depuis le rôle directement
  const roleAddr = (role?.address || [])[0];
  if (roleAddr) return parseAddress(roleAddr);

  // 3. Extension valueAddress dans le rôle
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
  const ville  = addr.city       || "";
  const parts  = [ligne1, cp && ville ? `${cp} ${ville}` : (ville || cp)].filter(Boolean);
  return { texte: parts.join(", "), codePostal: cp, ville };
}

function extractTelecom(role, org) {
  // Télécom du rôle en priorité, sinon de l'organisation
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
