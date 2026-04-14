/**
 * /functions/api/search.js
 * DoctoNET — Cloudflare Pages Function (proxy CORS)
 *
 * Ce Worker tourne côté serveur Cloudflare.
 * Il reçoit les requêtes du navigateur et interroge l'API RPPS
 * qui bloque les appels directs depuis un navigateur (CORS).
 *
 * Plan gratuit : 100 000 requêtes/jour — jamais facturé en cas de dépassement.
 * URL : https://www.doctonet.org/api/search?lat=48.88&lon=2.30&km=20&specialty=Médecin
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json;charset=UTF-8',
};

// API FHIR Annuaire Santé v2 — libre accès, sans clé (ANS / esante.gouv.fr)
const API_FINESS = 'https://gateway.api.esante.gouv.fr/fhir/v2/PractitionerRole';

export async function onRequest(context) {
  const { request } = context;

  // Preflight CORS
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Méthode non autorisée' }), {
      status: 405, headers: CORS_HEADERS
    });
  }

  try {
    const url    = new URL(request.url);
    const lat    = parseFloat(url.searchParams.get('lat'));
    const lon    = parseFloat(url.searchParams.get('lon'));
    const km        = parseFloat(url.searchParams.get('km') || '20');
    const specialty = url.searchParams.get('specialty') || '';

    if (isNaN(lat) || isNaN(lon)) {
      return new Response(JSON.stringify({ error: 'Paramètres lat/lon manquants' }), {
        status: 400, headers: CORS_HEADERS
      });
    }

    // Requête FHIR v2 — libre accès sans clé
    const params = new URLSearchParams({
      'location.near': `${lat}|${lon}|${km}|km`,
      '_include':      'PractitionerRole:practitioner',
      '_count':        '100',
      '_format':       'json',
    });

    const specialtyMap = {
      'Médecin':          'SM26',
      'Infirmier':        'SM60',
      'Kinésithérapeute': 'SM40',
      'Pharmacien':       'SM80',
      'Dentiste':         'SM55',
      'Psychiatre':       'SM26',
    };
    if (specialty && specialtyMap[specialty]) {
      params.append('specialty', specialtyMap[specialty]);
    }

    const apiRes = await fetch(`${API_FINESS}?${params.toString()}`, {
      headers: {
        'Accept':     'application/fhir+json',
        'User-Agent': 'DoctoNET/1.0 (contact@doctonet.org)',
      }
    });

    if (!apiRes.ok) {
      return new Response(JSON.stringify({
        error: `API Annuaire Santé indisponible (${apiRes.status})`,
        results: []
      }), { status: 200, headers: CORS_HEADERS });
    }

    const data    = await apiRes.json();
    const results = parseFHIR(data, lat, lon, km);

    return new Response(JSON.stringify({ results, total: results.length }), {
      status: 200, headers: CORS_HEADERS
    });

  } catch (err) {
    return new Response(JSON.stringify({
      error: 'Erreur serveur : ' + err.message,
      results: []
    }), { status: 200, headers: CORS_HEADERS });
  }
}

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
    const practId = role.practitioner?.reference?.split('/').pop();
    const pract   = practitioners[practId];

    // Nom
    let fullName = 'Professionnel de santé';
    if (pract?.name?.[0]) {
      const n = pract.name[0];
      fullName = [(n.given||[]).join(' '), n.family].filter(Boolean).join(' ') || fullName;
    }

    // Spécialité
    const specialty = role.specialty?.[0]?.coding?.[0]?.display
      || role.specialty?.[0]?.text
      || 'Professionnel de santé';

    // Adresse
    const addr       = pract?.address?.[0];
    const addrLine   = addr?.line?.[0] || '';
    const city       = addr?.city || '';
    const postalCode = addr?.postalCode || '';
    const addrFull   = [addrLine, postalCode, city].filter(Boolean).join(', ');

    // GPS
    let proLat = null, proLon = null;
    if (addr?.extension) {
      const geo = addr.extension.find(x => x.url?.includes('geolocation'));
      if (geo?.extension) {
        proLat = parseFloat(geo.extension.find(x => x.url === 'latitude')?.valueDecimal);
        proLon = parseFloat(geo.extension.find(x => x.url === 'longitude')?.valueDecimal);
      }
    }
    const distance = (proLat && proLon) ? haversine(refLat, refLon, proLat, proLon) : null;

    // Téléphone
    const telecom = role.telecom || pract?.telecom || [];
    const phone   = telecom.find(t => t.system === 'phone')?.value || '';

    return { fullName, specialty, addrFull, city, postalCode, phone, distance };
  })
  .filter(p => p.distance === null || p.distance <= km)
  .sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999));
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
