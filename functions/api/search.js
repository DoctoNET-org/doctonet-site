/**
 * DoctoNET — /api/search
 * Worker Cloudflare Pages — FHIR R4 Annuaire Santé v2
 *
 * Mode 1 — Recherche par NOM :
 *   ?nom=DUPONT
 *
 * Mode 2 — Recherche par SPÉCIALITÉ + CODE POSTAL :
 *   ?specialite=SM26&cp=75017   (codes SM* = spécialités ordinales TRE-R38)
 *   ?specialite=40&cp=75017     (codes numériques = professions TRE-G15)
 *
 *   IMPORTANT — Adresses :
 *   Les adresses sont dans les Organizations. Les PractitionerRoles référencent
 *   les Organizations via leur identifier FINESS (type IDNST), pas via _id FHIR.
 *   fetchOrgs utilise donc identifier=FINESS pour récupérer les adresses.
 *
 * ?next=URL → pagination
 */

const BASE  = "https://gateway.api.esante.gouv.fr/fhir/v2";
const COUNT = 50;

const SYS_QUALIFICATION = "https://mos.esante.gouv.fr/NOS/TRE_R38-SpecialiteOrdinale/FHIR/TRE-R38-SpecialiteOrdinale";
const SYS_ROLE_CODE     = "https://mos.esante.gouv.fr/NOS/TRE_G15-ProfessionSante/FHIR/TRE-G15-ProfessionSante";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const p   = url.searchParams;

  const nom        = (p.get("nom")        || "").trim();
  const specialite = (p.get("specialite") || "").trim();
  const cp         = (p.get("cp")         || "").trim();
  const nextUrl    = p.get("next") || "";
  const rawDebug   = p.get("_raw") === "1";

  const headers = {
    "ESANTE-API-KEY": env.ESANTE_API_KEY,
    "Accept": "application/fhir+json",
  };

  if (nextUrl)    return handleNextPage(nextUrl, headers);
  if (nom)        return searchByName(nom, headers, rawDebug);
  if (specialite) return searchBySpeciality(specialite, cp, headers, rawDebug);

  return jsonResponse({ error: "Parametre 'nom' ou 'specialite' requis." }, 400);
}

// ── MODE 1 : PAR NOM ────────────────────────────────────────────────────────
async function searchByName(nom, headers, rawDebug) {
  try {
    if (nom.length < 2) return jsonResponse({ error: "Saisissez au moins 2 lettres." }, 400);
    const fp = new URLSearchParams();
    fp.set("_count", String(COUNT));
    fp.set("active", "true");
    fp.set("family", nom);
    fp.append("_revinclude", "PractitionerRole:practitioner");
    const fhirUrl = `${BASE}/Practitioner?${fp}`;

    const resp1 = await fetch(fhirUrl, { headers });
    if (!resp1.ok) {
      const detail = await resp1.text();
      return jsonResponse({ error: "FHIR error", status: resp1.status, detail }, resp1.status);
    }
    const bundle1 = await resp1.json();
    if (rawDebug) return jsonResponse({ _url: fhirUrl, _bundle1: bundle1 });

    const { practitioners, roles, orgRefs } = indexBundle(bundle1);
    const orgs     = await fetchOrgsByRef(orgRefs, headers);
    const nextLink = getNextLink(bundle1);
    const results  = buildResults(practitioners, roles, orgs);

    return jsonResponse({
      total:   bundle1.total ?? results.length,
      count:   results.length,
      nextUrl: nextLink,
      results,
      _meta: { url: fhirUrl },
    });
  } catch (err) {
    return jsonResponse({ error: "Internal error", detail: err.message }, 500);
  }
}

// ── MODE 2 : PAR SPÉCIALITÉ + CP ────────────────────────────────────────────
async function searchBySpeciality(specialite, cp, headers, rawDebug) {
  try {
    const practitioners = {};
    const roles         = {};
    const orgs          = {};
    let   nextLink      = null;
    let   fhirUrl       = "";

    if (specialite.startsWith("SM")) {
      // Requête 1 : Practitioner?qualification-code + _revinclude PractitionerRole
      const fp1 = new URLSearchParams();
      fp1.set("_count", String(COUNT));
      fp1.set("active", "true");
      fp1.set("qualification-code", `${SYS_QUALIFICATION}|${specialite}`);
      fp1.append("_revinclude", "PractitionerRole:practitioner");
      fhirUrl = `${BASE}/Practitioner?${fp1}`;

      const resp1 = await fetch(fhirUrl, { headers });
      if (!resp1.ok) {
        const detail = await resp1.text();
        return jsonResponse({ error: "FHIR error", status: resp1.status, detail, _url: fhirUrl }, resp1.status);
      }
      const bundle1 = await resp1.json();
      nextLink = getNextLink(bundle1);

      // Indexation Practitioners + PractitionerRoles, collecte des refs Organization
      const orgRefs = new Map(); // fhirId → finessNumber
      for (const entry of (bundle1.entry || [])) {
        const res = entry.resource;
        if (!res) continue;
        if (res.resourceType === "Practitioner") {
          practitioners[res.id] = res;
        }
        if (res.resourceType === "PractitionerRole") {
          const practId = (res.practitioner?.reference || "").split("/").pop();
          if (practId && !roles[practId]) {
            roles[practId] = res;
            const orgFhirId = (res.organization?.reference || "").split("/").pop();
            const orgFiness = res.organization?.identifier?.value || "";
            if (orgFhirId && !orgRefs.has(orgFhirId)) {
              orgRefs.set(orgFhirId, orgFiness);
            }
          }
        }
      }

      if (rawDebug) return jsonResponse({
        _url: fhirUrl, _bundle1: bundle1,
        orgRefs: Object.fromEntries(orgRefs),
        practCount: Object.keys(practitioners).length,
        roleCount: Object.keys(roles).length,
      });

      // Requête 2 : Organizations par identifier FINESS
      if (orgRefs.size > 0) {
        const extra = await fetchOrgsByRef(orgRefs, headers);
        Object.assign(orgs, extra);
      }

    } else {
      // Professions (40, 60, 70…) : PractitionerRole?role-code + _include
      const fp = new URLSearchParams();
      fp.set("_count", String(COUNT));
      fp.set("active", "true");
      fp.set("role-code", `${SYS_ROLE_CODE}|${specialite}`);
      fp.append("_include", "PractitionerRole:practitioner");
      fp.append("_include", "PractitionerRole:organization");
      fhirUrl = `${BASE}/PractitionerRole?${fp}`;

      const resp1 = await fetch(fhirUrl, { headers });
      if (!resp1.ok) {
        const detail = await resp1.text();
        return jsonResponse({ error: "FHIR error", status: resp1.status, detail, _url: fhirUrl }, resp1.status);
      }
      const bundle1 = await resp1.json();
      if (rawDebug) return jsonResponse({ _url: fhirUrl, _bundle1: bundle1 });

      nextLink = getNextLink(bundle1);
      const orgRefs = new Map();

      for (const entry of (bundle1.entry || [])) {
        const res = entry.resource;
        if (!res) continue;
        if (res.resourceType === "Practitioner")  practitioners[res.id] = res;
        if (res.resourceType === "Organization")  orgs[res.id]          = res;
        if (res.resourceType === "PractitionerRole") {
          const practId = (res.practitioner?.reference || "").split("/").pop();
          if (practId && !roles[practId]) {
            roles[practId] = res;
            const orgFhirId = (res.organization?.reference || "").split("/").pop();
            const orgFiness = res.organization?.identifier?.value || "";
            if (orgFhirId && !orgs[orgFhirId]) orgRefs.set(orgFhirId, orgFiness);
          }
        }
      }
      if (orgRefs.size > 0) {
        const extra = await fetchOrgsByRef(orgRefs, headers);
        Object.assign(orgs, extra);
      }
    }

    let results = buildResults(practitioners, roles, orgs);

    // Filtrage département (2 premiers chiffres du CP)
    if (cp && cp.length >= 2) {
      const dept = cp.slice(0, 2);
      results = results.filter(r => r.codePostal.startsWith(dept));
    }

    return jsonResponse({
      total:   results.length,
      count:   results.length,
      nextUrl: nextLink,
      results,
      _meta:   { url: fhirUrl, dept: cp ? cp.slice(0, 2) : null },
    });
  } catch (err) {
    return jsonResponse({ error: "Internal error", detail: err.message }, 500);
  }
}

// ── PAGINATION ───────────────────────────────────────────────────────────────
async function handleNextPage(nextUrl, headers) {
  try {
    const resp = await fetch(nextUrl, { headers });
    if (!resp.ok) throw new Error(`FHIR error ${resp.status}`);
    const bundle = await resp.json();

    const practitioners = {};
    const roles         = {};
    const orgs          = {};
    const orgRefs       = new Map();

    for (const entry of (bundle.entry || [])) {
      const res = entry.resource;
      if (!res) continue;
      if (res.resourceType === "Practitioner")  practitioners[res.id] = res;
      if (res.resourceType === "Organization")  orgs[res.id]          = res;
      if (res.resourceType === "PractitionerRole") {
        const practId = (res.practitioner?.reference || "").split("/").pop();
        if (practId && !roles[practId]) {
          roles[practId] = res;
          const orgFhirId = (res.organization?.reference || "").split("/").pop();
          const orgFiness = res.organization?.identifier?.value || "";
          if (orgFhirId && !orgs[orgFhirId]) orgRefs.set(orgFhirId, orgFiness);
        }
      }
    }

    if (orgRefs.size > 0) {
      const extra = await fetchOrgsByRef(orgRefs, headers);
      Object.assign(orgs, extra);
    }

    return jsonResponse({
      total:   bundle.total ?? Object.keys(practitioners).length,
      count:   Object.keys(practitioners).length,
      nextUrl: getNextLink(bundle),
      results: buildResults(practitioners, roles, orgs),
    });
  } catch (err) {
    return jsonResponse({ error: "Internal error", detail: err.message }, 500);
  }
}

// ── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * indexBundle : indexe un bundle Practitioner + _revinclude PractitionerRole
 * Retourne une Map orgRefs : fhirId → finessNumber
 */
function indexBundle(bundle) {
  const practitioners = {};
  const roles         = {};
  const orgRefs       = new Map();
  for (const entry of (bundle.entry || [])) {
    const res = entry.resource;
    if (!res) continue;
    if (res.resourceType === "Practitioner") {
      practitioners[res.id] = res;
    } else if (res.resourceType === "PractitionerRole") {
      const practId = (res.practitioner?.reference || "").split("/").pop();
      if (practId && !roles[practId]) {
        roles[practId] = res;
        const orgFhirId = (res.organization?.reference || "").split("/").pop();
        const orgFiness = res.organization?.identifier?.value || "";
        if (orgFhirId) orgRefs.set(orgFhirId, orgFiness);
      }
    }
  }
  return { practitioners, roles, orgRefs };
}

/**
 * fetchOrgsByRef : récupère les Organizations depuis l'API FHIR
 * Essaie d'abord par _id (FHIR ID), puis par identifier (FINESS) si 0 résultat
 * Retourne un objet { fhirId: organizationResource }
 */
async function fetchOrgsByRef(orgRefs, headers) {
  const orgs = {};
  if (!orgRefs.size) return orgs;

  const fhirIds  = [...orgRefs.keys()].filter(Boolean);
  const finessNs = [...orgRefs.values()].filter(Boolean);

  try {
    // Tentative 1 : par _id FHIR
    const fp1 = new URLSearchParams();
    fp1.set("_id", fhirIds.join(","));
    fp1.set("_count", "100");
    const resp1 = await fetch(`${BASE}/Organization?${fp1}`, { headers });
    if (resp1.ok) {
      const b1 = await resp1.json();
      if ((b1.total ?? (b1.entry||[]).length) > 0) {
        for (const entry of (b1.entry || [])) {
          const res = entry.resource;
          if (res?.resourceType === "Organization") orgs[res.id] = res;
        }
        if (Object.keys(orgs).length > 0) return orgs;
      }
    }
  } catch (_) {}

  // Tentative 2 : par identifier FINESS si _id n'a rien retourné
  if (finessNs.length > 0) {
    try {
      for (const finess of finessNs.slice(0, 50)) {
        if (!finess) continue;
        const fp2 = new URLSearchParams();
        fp2.set("identifier", finess);
        fp2.set("_count", "1");
        const resp2 = await fetch(`${BASE}/Organization?${fp2}`, { headers });
        if (!resp2.ok) continue;
        const b2 = await resp2.json();
        for (const entry of (b2.entry || [])) {
          const res = entry.resource;
          if (res?.resourceType === "Organization") orgs[res.id] = res;
        }
      }
    } catch (_) {}
  }

  return orgs;
}

function getNextLink(bundle) {
  return (bundle.link || []).find(l => l.relation === "next")?.url || null;
}

function buildResults(practitioners, roles, orgs) {
  return Object.values(practitioners).map((pract) => {
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
}

function extractNom(pract) {
  if (!pract) return "Nom inconnu";
  const hn = (pract.name || []).find(n => n.use === "official") || (pract.name || [])[0];
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
  const orgAddr = (org?.address || [])[0];
  if (orgAddr) return parseAddress(orgAddr);
  const roleAddr = (role?.address || [])[0];
  if (roleAddr) return parseAddress(roleAddr);
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
    telephone: t.find(x => x.system === "phone")?.value || "",
    email:     t.find(x => x.system === "email")?.value || "",
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
