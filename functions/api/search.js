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

// API FINESS data.gouv.fr — publique, sans clé, accessible depuis un serveur
const API_FINESS = 'https://data.opendatasoft.com/api/explore/v2.1/catalog/datasets/finess-etablissements@public/records';

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
    const km     = parseFloat(url.searchParams.get('km') || '20');
    const specialty = url.searchParams.get('specialty') || '';

    if (isNaN(lat) || isNaN(lon)) {
      return new Response(JSON.stringify({ error: 'Paramètres lat/lon manquants' }), {
        status: 400, headers: CORS_HEADERS
      });
    }

    // Filtre géographique FINESS
    const radiusM = km * 1000;
    let where = `distance(geolocalisation, geom'POINT(${lon} ${lat})', ${radiusM}m)`;

    const specialtyMap = {
      'Médecin':          'Médecine',
      'Infirmier':        'Soins infirmiers',
      'Kinésithérapeute': 'Rééducation',
      'Pharmacien':       'Pharmacie',
      'Dentiste':         'Odontologie',
      'Psychiatre':       'Psychiatrie',
    };
    if (specialty && specialtyMap[specialty]) {
      where += ` AND libcattetab like "%${specialtyMap[specialty]}%"`;
    }

    const params = new URLSearchParams({
      where,
      limit: '100',
      order_by: `distance(geolocalisation, geom'POINT(${lon} ${lat})')`,
      select: 'rs,libcattetab,numvoie,typvoie,voie,commune,ligneacheminement,telephone,geolocalisation',
    });

    const apiRes = await fetch(`${API_FINESS}?${params.toString()}`, {
      headers: { 'User-Agent': 'DoctoNET/1.0 (contact@doctonet.org)' }
    });

    if (!apiRes.ok) {
      return new Response(JSON.stringify({
        error: `API FINESS indisponible (${apiRes.status})`,
        results: []
      }), { status: 200, headers: CORS_HEADERS });
    }

    const data = await apiRes.json();
    const results = parseFINESS(data, lat, lon, km);

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

function parseFINESS(data, refLat, refLon, km) {
  if (!data.results) return [];
  return data.results.map(r => {
    const fullName  = r.rs || 'Établissement de santé';
    const specialty = r.libcattetab || 'Professionnel de santé';
    const addr      = [r.numvoie, r.typvoie, r.voie].filter(Boolean).join(' ');
    const city      = r.ligneacheminement || r.commune || '';
    const addrFull  = [addr, city].filter(Boolean).join(', ');
    const phone     = r.telephone || '';
    const geo       = r.geolocalisation;
    const distance  = (geo?.lat && geo?.lon) ? haversine(refLat, refLon, geo.lat, geo.lon) : null;
    return { fullName, specialty, addrFull, city, phone, distance };
  })
  .filter(p => p.distance === null || p.distance <= km)
  .sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999));
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
