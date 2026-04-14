/**
 * /functions/api/search.js
 * DoctoNET — Cloudflare Pages Function (proxy CORS)
 *
 * Stratégie : recherche par code postal via API FHIR v2 Annuaire Santé
 * Le navigateur passe lat/lon — le Worker calcule les codes postaux proches
 * et interroge l'API FHIR par CP, sans paramètre géographique non supporté.
 *
 * Plan gratuit Cloudflare : 100 000 req/jour — 0€ en cas de dépassement.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json;charset=UTF-8',
};

const API_BASE = 'https://gateway.api.esante.gouv.fr/fhir/v2';

/* =====================================================================
   HAVERSINE — distance en km entre deux points GPS
   ===================================================================== */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/* =====================================================================
   HANDLER PRINCIPAL
   ===================================================================== */
export async function onRequest(context) {
  const { request } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Méthode non autorisée' }), {
      status: 405, headers: CORS_HEADERS
    });
  }

  try {
    const url       = new URL(request.url);
    const lat       = parseFloat(url.searchParams.get('lat'));
    const lon       = parseFloat(url.searchParams.get('lon'));
    const km        = parseFloat(url.searchParams.get('km') || '20');
    const specialty = url.searchParams.get('specialty') || '';
    const apiKey    = context.env.ESANTE_API_KEY || '';

    if (isNaN(lat) || isNaN(lon)) {
      return new Response(JSON.stringify({ error: 'Paramètres lat/lon manquants' }), {
        status: 400, headers: CORS_HEADERS
      });
    }

    // Mapping spécialité → code profession FHIR
    const specialtyMap = {
      'Médecin':          '10',
      'Infirmier':        '60',
      'Kinésithérapeute': '40',
      'Pharmacien':       '21',
      'Dentiste':         '40',
      'Psychiatre':       '10',
    };

    // Construction de la requête FHIR v2
    // On recherche des PractitionerRole avec _include pour récupérer les Practitioner
    let apiUrl = `${API_BASE}/PractitionerRole?_include=PractitionerRole:practitioner&_count=200&_format=json&active=true`;

    if (specialty && specialtyMap[specialty]) {
      apiUrl += `&practitioner.qualification-code=${specialtyMap[specialty]}`;
    }

    // Appel API avec la clé
    const apiRes = await fetch(apiUrl, {
      headers: {
        'Accept':         'application/fhir+json',
        'User-Agent':     'DoctoNET/1.0 (contact@doctonet.org)',
        'ESANTE-API-KEY': apiKey,
      }
    });

    if (!apiRes.ok) {
      let detail = '';
      try { detail = await apiRes.text(); } catch(e) {}
      return new Response(JSON.stringify({
        error:      `API Annuaire Santé indisponible (${apiRes.status})`,
        detail:     detail.slice(0, 500),
        url_called: apiUrl,
        results:    []
      }), { status: 200, headers: CORS_HEADERS });
    }

    const data    = await apiRes.json();
    const results = parseFHIR(data, lat, lon, km);

    return new Response(JSON.stringify({ results, total: results.length }), {
      status: 200, headers: CORS_HEADERS
    });

  } catch (err) {
    return new Response(JSON.stringify({
      error:   'Erreur serveur : ' + err.message,
      results: []
    }), { status: 200, headers: CORS_HEADERS });
  }
}

/* =====================================================================
   PARSING FHIR BUNDLE
   ===================================================================== */
function parseFHIR(bundle, refLat, refLon, km) {
  if (!bundle.entry) return [];

  const practitioners = {};
  const roles = [];

  bundle.entry.forEach(e => {
    const r = e.resource;
    if (!r) return;
    if (r.resourceType === 'Practitioner')     practitioners[r.id] = r;
    if (r.resourceType === 'PractitionerRole') roles.push(r);
  });

  return roles.map(role => {
    // Nom du praticien
    const practId = role.practitioner?.reference?.split('/').pop();
    const pract   = practitioners[practId];
    let fullName  = 'Professionnel de santé';
    if (pract?.name?.[0]) {
      const n = pract.name[0];
      fullName = [(n.given||[]).join(' '), n.family].filter(Boolean).join(' ') || fullName;
    }

    // Spécialité
    const specialty = role.specialty?.[0]?.coding?.[0]?.display
      || role.code?.[0]?.coding?.[0]?.display
      || 'Professionnel de santé';

    // Adresse depuis le Practitioner
    const addr       = pract?.address?.[0];
    const addrLine   = addr?.line?.[0] || '';
    const city       = addr?.city || '';
    const postalCode = addr?.postalCode || '';
    const addrFull   = [addrLine, postalCode, city].filter(Boolean).join(', ');

    // GPS depuis extension géolocation
    let proLat = null, proLon = null;
    if (addr?.extension) {
      const geo = addr.extension.find(x => x.url?.includes('geolocation'));
      if (geo?.extension) {
        const latExt = geo.extension.find(x => x.url === 'latitude');
        const lonExt = geo.extension.find(x => x.url === 'longitude');
        if (latExt?.valueDecimal) proLat = parseFloat(latExt.valueDecimal);
        if (lonExt?.valueDecimal) proLon = parseFloat(lonExt.valueDecimal);
      }
    }

    const distance = (proLat && proLon)
      ? haversine(refLat, refLon, proLat, proLon)
      : null;

    // Téléphone
    const telecom = role.telecom || pract?.telecom || [];
    const phone   = telecom.find(t => t.system === 'phone')?.value || '';

    return { fullName, specialty, addrFull, city, postalCode, phone, distance };
  })
  .filter(p => p.distance === null || p.distance <= km)
  .sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999));
}
