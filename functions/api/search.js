/**
 * DoctoNET — /api/search
 * Worker Cloudflare Pages — FHIR R4 Annuaire Santé v2
 *
 * Mode 1 — Recherche par NOM :
 *   ?nom=DUPONT
 *
 * Mode 2 — Recherche par SPÉCIALITÉ + CODE POSTAL :
 *   ?specialite=SM26&cp=75017
 *   ?specialite=40&cp=69000
 *
 *   Stratégie :
 *   - Codes SM* → spécialités ordinales  (système TRE-R38)
 *   - Codes numériques courts → professions de santé (système TRE-G15)
 *   - Filtrage géo côté serveur sur le département (2 premiers chiffres du CP)
 *     car le paramètre FHIR `near` n'est pas supporté sur gateway.api.esante.gouv.fr/fhir/v2
 *
 * ?next=URL  → pagination (les deux modes)
 */

const BASE  = "https://gateway.api.esante.gouv.fr/fhir/v2";
const COUNT = 50; // Plus large pour compenser l'absence de filtre géo FHIR natif

// Systèmes FHIR de l'Annuaire Santé (requis pour que le filtre specialty fonctionne)
const SYS_SPECIALITE = "https://mos.esante.gouv.fr/NOS/TRE_R38-SpecialiteOrdinale/FHIR/TRE-R38-SpecialiteOrdinale";
const SYS_PROFESSION = "https://mos.esante.gouv.fr/NOS/TRE_G15-ProfessionSante/FHIR/TRE-G15-ProfessionSante";

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
    // Choisir le bon système FHIR selon le format du code
    const systeme = specialite.startsWith("SM")
      ? SYS_SPECIALITE
      : SYS_PROFESSION;

    const fp = new URLSearchParams();
    fp.set("_count", String(COUNT));
    fp.set("active", "true");
    // Format système|code obligatoire pour l'API esante
    fp.set("specialty", `${systeme}|${specialite}`);
    fp.append("_include", "PractitionerRole:practitioner");
    fp.append("_include", "PractitionerRole:organization");

    const fhirUrl = `${BASE}/PractitionerRole?${fp}`;
    const resp1   = await fetch(fhirUrl, { headers });

    if (!resp1.ok) {
      const detail = await resp1.text();
      return jsonResponse({ error: "FHIR error", status: resp1.status, detail, _url: fhirUrl }, resp1.status);
    }
    const bundle1 = await resp1.json();
    if (rawDebug) return jsonResponse({ _url: fhirUrl, _bundle1: bundle1 });

    // Indexation du bundle (_include ramène Practitioner + Organization)
    const practitioners = {};
    const roles         = {};
    const orgs          = {};
    const missingOrgIds = new Set();

    for (const entry of (bundle1.entry || [])) {
      const res = entry.resource;
      if (!res) continue;
      if (res.resourceType === "Practitioner")  practitioners[res.id] = res;
      if (res.resourceType === "Organization")  orgs[res.id]          = res;
      if (res.resourceType === "PractitionerRole") {
        const practId = (res.practitioner?.reference || "").split("/").pop();
        if (practId && !roles[practId]) {
          roles[practId] = res;
          const orgId = (res.organization?.reference || "").split("/").pop();
          if (orgId && !orgs[orgId]) missingOrgIds.add(orgId);
        }
      }
    }

    // Orgs manquantes non incluses dans le bundle
    if (missingOrgIds.size > 0) {
      const extra = await fetchOrgs([...missingOrgIds], headers);
      Object.assign(orgs, extra);
    }

    const nextLink = getNextLink(bundle1);
    let results    = buildResults(practitioners, roles, orgs);

    // Filtrage géographique côté serveur par département (2 premiers chiffres du CP)
    // Ex : cp=75017 → département "75", cp=69003 → département "69"
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

    // Fallback : bundle Practitioner pur (mode nom, page suivante)
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

    const nextLink = getNextLink(bundle);
    const results  = buildResults(practitioners, roles, orgs);

    return jsonResponse({
      total:   bundle.total ?? results.length,
      count:   results.length,
      nextUrl: nextLink,
      results,
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
