/**
 * DoctoNET — /api/search
 * Worker Cloudflare Pages — FHIR R4 Annuaire Santé v2
 *
 * Mode 1 — Recherche par NOM :
 *   ?nom=DUPONT
 *   Practitioner?family + _revinclude PractitionerRole → fetchOrgs
 *
 * Mode 2 — Recherche par SPÉCIALITÉ + CODE POSTAL :
 *   ?specialite=SM26&cp=75017   (codes SM* = spécialités ordinales TRE-R38)
 *   ?specialite=40&cp=75017     (codes numériques = professions TRE-G15)
 *
 *   Stratégie SM* (2 requêtes) :
 *   1. Practitioner?qualification-code=TRE-R38|SMxx + _revinclude PractitionerRole
 *      → on récupère Practitioners + PractitionerRoles (avec org references)
 *   2. PractitionerRole?practitioner=id1,id2… + _include Organization
 *      → on récupère les Organizations pour les adresses
 *
 *   Stratégie codes numériques (1 requête) :
 *   PractitionerRole?role-code=TRE-G15|xx + _include Practitioner + Organization
 *
 *   Filtrage département côté Worker (2 premiers chiffres du CP)
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

    const { practitioners, roles, orgIds } = indexBundle(bundle1);
    const orgs     = await fetchOrgs([...orgIds], headers);
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
      // ── STRATÉGIE 2 REQUÊTES pour les spécialités ordinales (SM*) ─────────
      //
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

      // Indexation Practitioners + PractitionerRoles
      const practIds   = [];
      const missingOrgs = new Set();
      for (const entry of (bundle1.entry || [])) {
        const res = entry.resource;
        if (!res) continue;
        if (res.resourceType === "Practitioner") {
          practitioners[res.id] = res;
          practIds.push(res.id);
        }
        if (res.resourceType === "PractitionerRole") {
          const practId = (res.practitioner?.reference || "").split("/").pop();
          if (practId && !roles[practId]) {
            roles[practId] = res;
            const orgId = (res.organization?.reference || "").split("/").pop();
            if (orgId) missingOrgs.add(orgId);
          }
        }
      }

      // Requête 2 : récupération des Organizations pour avoir les adresses
      let orgBundle = null;
      if (missingOrgs.size > 0) {
        const fp2 = new URLSearchParams();
        fp2.set("_id", [...missingOrgs].join(","));
        fp2.set("_count", "100");
        const orgUrl = `${BASE}/Organization?${fp2}`;
        const resp2 = await fetch(orgUrl, { headers });
        if (resp2.ok) {
          orgBundle = await resp2.json();
          for (const entry of (orgBundle.entry || [])) {
            const res = entry.resource;
            if (res?.resourceType === "Organization") orgs[res.id] = res;
          }
        }
        if (rawDebug) return jsonResponse({
          _url: fhirUrl,
          _bundle1: bundle1,
          orgIds: [...missingOrgs],
          _orgUrl: orgUrl,
          _orgBundle: orgBundle,
          orgsFound: Object.keys(orgs).length,
        });
      } else if (rawDebug) {
        return jsonResponse({ _url: fhirUrl, _bundle1: bundle1, orgIds: [], orgsFound: 0 });
      }

    } else {
      // ── STRATÉGIE 1 REQUÊTE pour les professions (40, 60, 70…) ───────────
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
      const missingOrgIds = new Set();

      for (const entry of (bundle1.entry || [])) {
        const res = entry.resource;
        if (!res) continue;
        if (res.resourceType === "Practitioner")     practitioners[res.id] = res;
        if (res.resourceType === "Organization")     orgs[res.id]          = res;
        if (res.resourceType === "PractitionerRole") {
          const practId = (res.practitioner?.reference || "").split("/").pop();
          if (practId && !roles[practId]) {
            roles[practId] = res;
            const orgId = (res.organization?.reference || "").split("/").pop();
            if (orgId && !orgs[orgId]) missingOrgIds.add(orgId);
          }
        }
      }
      if (missingOrgIds.size > 0) {
        const extra = await fetchOrgs([...missingOrgIds], headers);
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
    const orgIds        = new Set();

    for (const entry of (bundle.entry || [])) {
      const res = entry.resource;
      if (!res) continue;
      if (res.resourceType === "Practitioner")     practitioners[res.id] = res;
      if (res.resourceType === "Organization")     orgs[res.id]          = res;
      if (res.resourceType === "PractitionerRole") {
        const practId = (res.practitioner?.reference || "").split("/").pop();
        if (practId && !roles[practId]) {
          roles[practId] = res;
          const orgId = (res.organization?.reference || "").split("/").pop();
          if (orgId && !orgs[orgId]) orgIds.add(orgId);
        }
      }
    }

    // Fallback bundle Practitioner pur
    if (!Object.keys(roles).length) {
      const indexed = indexBundle(bundle);
      Object.assign(practitioners, indexed.practitioners);
      Object.assign(roles, indexed.roles);
      indexed.orgIds.forEach(id => orgIds.add(id));
    }

    if (orgIds.size > 0) {
      const extra = await fetchOrgs([...orgIds], headers);
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
function indexBundle(bundle) {
  const practitioners = {};
  const roles         = {};
  const orgIds        = new Set();
  for (const entry of (bundle.entry || [])) {
    const res = entry.resource;
    if (!res) continue;
    if (res.resourceType === "Practitioner") {
      practitioners[res.id] = res;
    } else if (res.resourceType === "PractitionerRole") {
      const practId = (res.practitioner?.reference || "").split("/").pop();
      if (practId && !roles[practId]) {
        roles[practId] = res;
        const orgId = (res.organization?.reference || "").split("/").pop();
        if (orgId) orgIds.add(orgId);
      }
    }
  }
  return { practitioners, roles, orgIds };
}

async function fetchOrgs(orgIdArr, headers) {
  const orgs = {};
  if (!orgIdArr.length) return orgs;
  try {
    const fp = new URLSearchParams();
    fp.set("_id", orgIdArr.join(","));
    fp.set("_count", "100");
    const resp = await fetch(`${BASE}/Organization?${fp}`, { headers });
    if (!resp.ok) return orgs;
    const bundle = await resp.json();
    for (const entry of (bundle.entry || [])) {
      const res = entry.resource;
      if (res?.resourceType === "Organization") orgs[res.id] = res;
    }
  } catch (_) { /* silencieux */ }
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
