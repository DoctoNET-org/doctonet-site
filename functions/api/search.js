/**
 * DoctoNET — /api/search
 * Worker Cloudflare Pages — FHIR R4 Annuaire Santé v2
 *
 * Mode 1 — Recherche par NOM :
 *   ?nom=DUPONT
 *
 * Mode 2 — Recherche par SPÉCIALITÉ + CODE POSTAL :
 *   ?specialite=SM26&cp=75017
 *   ?specialite=40&cp=75017
 *
 *   Paramètres FHIR supportés confirmés sur gateway.api.esante.gouv.fr/fhir/v2 :
 *   - Practitioner : family, qualification-code, _revinclude
 *   - PractitionerRole : practitioner (ref), organization (ref), _include
 *   - Organization : _id, identifier
 *   NON supportés : specialty, role-code, near (sur PractitionerRole)
 *
 *   Stratégie unifiée pour SM* ET codes numériques (40, 60, 70…) :
 *   1. Practitioner?qualification-code=SYSTEM|CODE + _revinclude PractitionerRole
 *   2. Organization?_id=id1,id2,… (batch unique, pas de boucle séquentielle)
 *
 *   Le système FHIR varie selon le type de code :
 *   - SM* → TRE_R38-SpecialiteOrdinale
 *   - numérique → TRE_G15-ProfessionSante
 *
 * ?next=URL → pagination
 */

const BASE  = "https://gateway.api.esante.gouv.fr/fhir/v2";
const COUNT = 50;

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

    const { practitioners, roles, orgFhirIds } = indexBundle(bundle1);
    const orgs     = await fetchOrgsByFhirId(orgFhirIds, headers);
    const nextLink = getNextLink(bundle1);
    const results  = buildResults(practitioners, roles, orgs);

    return jsonResponse({
      total:   bundle1.total ?? results.length,
      count:   results.length,
      nextUrl: nextLink,
      results,
      _meta:   { url: fhirUrl },
    });
  } catch (err) {
    return jsonResponse({ error: "Internal error", detail: err.message }, 500);
  }
}

// ── MODE 2 : PAR SPÉCIALITÉ + CP ────────────────────────────────────────────
// Stratégie unifiée : Practitioner?qualification-code pour SM* ET codes numériques
async function searchBySpeciality(specialite, cp, headers, rawDebug) {
  try {
    // Choix du système selon le type de code
    const systeme = specialite.startsWith("SM") ? SYS_SPECIALITE : SYS_PROFESSION;

    // Requête 1 : Practitioners correspondant au code + leurs PractitionerRoles
    const fp1 = new URLSearchParams();
    fp1.set("_count", String(COUNT));
    fp1.set("active", "true");
    fp1.set("qualification-code", `${systeme}|${specialite}`);
    fp1.append("_revinclude", "PractitionerRole:practitioner");
    const fhirUrl = `${BASE}/Practitioner?${fp1}`;

    const resp1 = await fetch(fhirUrl, { headers });
    if (!resp1.ok) {
      const detail = await resp1.text();
      return jsonResponse({ error: "FHIR error", status: resp1.status, detail, _url: fhirUrl }, resp1.status);
    }
    const bundle1 = await resp1.json();

    const { practitioners, roles, orgFhirIds } = indexBundle(bundle1);

    if (rawDebug) return jsonResponse({
      _url:       fhirUrl,
      _bundle1:   bundle1,
      orgFhirIds: orgFhirIds,
      practCount: Object.keys(practitioners).length,
      roleCount:  Object.keys(roles).length,
    });

    // Requête 2 : Organizations en batch unique par _id FHIR
    const orgs = await fetchOrgsByFhirId(orgFhirIds, headers);

    let results = buildResults(practitioners, roles, orgs);

    // Filtrage département (2 premiers chiffres du CP)
    if (cp && cp.length >= 2) {
      const dept = cp.slice(0, 2);
      results = results.filter(r => !r.codePostal || r.codePostal.startsWith(dept));
    }

    return jsonResponse({
      total:   results.length,
      count:   results.length,
      nextUrl: getNextLink(bundle1),
      results,
      _meta:   { url: fhirUrl, dept: cp ? cp.slice(0, 2) : null, orgsFound: Object.keys(orgs).length },
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

    const { practitioners, roles, orgFhirIds } = indexBundle(bundle);
    const orgs = await fetchOrgsByFhirId(orgFhirIds, headers);

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
 * Retourne les FHIR IDs des Organizations référencées dans les rôles
 */
function indexBundle(bundle) {
  const practitioners = {};
  const roles         = {};
  const orgFhirIds    = new Set();

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
        if (orgId) orgFhirIds.add(orgId);
      }
    }
  }
  return { practitioners, roles, orgFhirIds: [...orgFhirIds] };
}

/**
 * fetchOrgsByFhirId : batch unique — cherche les Organizations par _id FHIR
 * Si 0 résultat, tente par les identifiers FINESS extraits des PractitionerRoles
 * Note : sur l'API esante, Organization?_id=001-01-XXXXX fonctionne
 *        si les IDs sont corrects (format 001-XX-XXXXXX)
 */
async function fetchOrgsByFhirId(orgFhirIds, headers) {
  const orgs = {};
  if (!orgFhirIds.length) return orgs;

  try {
    // Batch : tous les IDs en une seule requête
    const fp = new URLSearchParams();
    fp.set("_id", orgFhirIds.join(","));
    fp.set("_count", "100");
    const orgUrl = `${BASE}/Organization?${fp}`;
    const resp = await fetch(orgUrl, { headers });

    if (resp.ok) {
      const bundle = await resp.json();
      for (const entry of (bundle.entry || [])) {
        const res = entry.resource;
        if (res?.resourceType === "Organization") orgs[res.id] = res;
      }
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

function getAllowedOrigin(request) {
  const origin = request?.headers?.get("Origin") || "";
  if (origin === "https://www.doctonet.org" || origin === "https://doctonet.org") {
    return origin;
  }
  return "https://www.doctonet.org";
}

function jsonResponse(data, status = 200, request = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": getAllowedOrigin(request),
    },
  });
}
