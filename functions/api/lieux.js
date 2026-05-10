/**
 * DoctoNET — /api/lieux
 * Cloudflare Pages Function
 *
 * Stratégie :
 *   1. CP → coordonnées GPS via api-adresse.data.gouv.fr
 *   2. Coordonnées → liste lieux (id+nom+coords) via /api/lieux/chunk
 *   3. Détail de chaque lieu via /api/lieux/{id} (adresse, téléphone, horaires…)
 *   4. Lieux DoctoNET embarqués en tête
 *
 * Route : GET /api/lieux?cp=75020&type=ateliers
 */

const CARTO_BASE = 'https://cartographie.societenumerique.gouv.fr/api/lieux';

// ── Lieux DoctoNET embarqués ──────────────────────────────────────────────────
const LIEUX_DOCTONET = {
  ateliers: [
    {
      id: "doctonet-atelier-001",
      nom: "Le Trèfle",
      adresse: "12 rue des Lilas, 95230 Soisy-sous-Montmorency",
      code_postal: "95230",
      ville: "Soisy-sous-Montmorency",
      telephone: "01 39 59 00 00",
      email: "contact@letrefle95.fr",
      site: "https://www.letrefle95.fr",
      horaires: "Lun–Ven 9h–12h et 14h–17h",
      description: "Ateliers collectifs d'initiation et de perfectionnement au numérique. Petits groupes, ambiance conviviale, animateurs bénévoles formés.",
      gratuit: true,
      services: ["wifi", "postes_libres", "impression"],
      source: "doctonet",
      type: "ateliers",
    },
    {
      id: "doctonet-atelier-002",
      nom: "Aide numérique pour les seniors — Mairie du 17e",
      adresse: "Salle 228, 2e étage — Mairie du 17e, 16 rue des Batignolles, 75017 Paris",
      code_postal: "75017",
      ville: "Paris 17e",
      telephone: "01 44 69 16 01",
      email: "delegationseniors17@gmail.com",
      site: "",
      horaires: "Mercredis 14h–17h (séances d'1h, sur rendez-vous)",
      description: "Un aidant numérique vous accompagne pendant 1h : naviguer sur internet, utiliser un ordinateur, réaliser ses démarches en ligne. Apportez votre téléphone, ordinateur ou tablette. Animé par des bénévoles Heure Civique.",
      gratuit: true,
      services: ["wifi"],
      source: "doctonet",
      type: "ateliers",
    },
  ],
  france_services: [],
  acces_libre: [],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

/**
 * CP → coordonnées GPS
 */
async function codePostalToCoords(cp) {
  const url = `https://api-adresse.data.gouv.fr/search/?q=${cp}&type=municipality&limit=1`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`api-adresse HTTP ${res.status}`);
  const data = await res.json();
  const feature = data.features?.[0];
  if (!feature) throw new Error(`Aucune commune pour CP ${cp}`);
  const [longitude, latitude] = feature.geometry.coordinates;
  const ville = feature.properties.city || feature.properties.label || "";
  return { latitude, longitude, ville };
}

/**
 * Coordonnées → liste légère (id, nom, lat, lon)
 */
async function fetchChunk(latitude, longitude) {
  const url = `${CARTO_BASE}/chunk?latitude=${latitude}&longitude=${longitude}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 3600 },
  });
  if (!res.ok) throw new Error(`chunk HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Détail complet d'un lieu par son id
 *
 * Cloudflare Workers ré-encode les URLs passées à fetch() si elles contiennent
 * des caractères non-ASCII. On utilise new Request() avec l'URL pré-construite
 * via une concaténation simple pour éviter tout ré-encodage.
 */
async function fetchDetail(id) {
  // On encode uniquement les caractères non-ASCII (accents) mais on préserve
  // les caractères valides dans un path URL : - _ . ~ 0-9 A-Z a-z
  let idEncode = '';
  for (const ch of id) {
    const code = ch.charCodeAt(0);
    if (
      (code >= 0x41 && code <= 0x5A) || // A-Z
      (code >= 0x61 && code <= 0x7A) || // a-z
      (code >= 0x30 && code <= 0x39) || // 0-9
      ch === '-' || ch === '_' || ch === '.' || ch === '~'
    ) {
      idEncode += ch;
    } else {
      // Encode le caractère en UTF-8 percent-encoded
      idEncode += encodeURIComponent(ch);
    }
  }

  const url = CARTO_BASE + '/' + idEncode;
  const req = new Request(url, { method: 'GET', headers: { Accept: 'application/json' } });
  const res = await fetch(req, { cf: { cacheTtl: 3600 } });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Distance Haversine en km
 */
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Détermine le type d'un lieu
 */
function detecterType(nom) {
  const n = (nom || "").toLowerCase();
  if (n.includes("france services") || n.includes("france service") || n.includes("msap")) {
    return "france_services";
  }
  if (n.includes("biblioth") || n.includes("médiath") || n.includes("ludoth")) {
    return "acces_libre";
  }
  return "ateliers";
}

/**
 * Détecte les services depuis les données détaillées
 */
function detectServices(detail) {
  const services = [];
  const materiel = detail.materielInformatique || [];
  const desc = (detail.description || detail.presentationResume || "").toLowerCase();

  if (materiel.some(m => m.toLowerCase().includes("accès internet")) || desc.includes("internet") || desc.includes("wifi")) {
    services.push("wifi");
  }
  if (materiel.some(m => m.toLowerCase().includes("ordinateur") || m.toLowerCase().includes("poste"))) {
    services.push("postes_libres");
  }
  if (desc.includes("impression") || desc.includes("imprimer") || desc.includes("scanner")) {
    services.push("impression");
  }
  return services;
}

/**
 * Formate les horaires OSM en texte lisible
 * Ex: "Mo 09:00-12:00,14:00-17:00" → "Lun 9h–12h / 14h–17h"
 */
function formatHoraires(osmStr) {
  if (!osmStr) return "";
  // Retourne la chaîne brute si trop complexe à parser — mieux que rien
  return osmStr
    .replace(/Mo/g, "Lun").replace(/Tu/g, "Mar").replace(/We/g, "Mer")
    .replace(/Th/g, "Jeu").replace(/Fr/g, "Ven").replace(/Sa/g, "Sam").replace(/Su/g, "Dim")
    .replace(/,/g, " / ")
    .replace(/:00/g, "h")
    .replace(/(\d+h)-(\d+h)/g, "$1–$2");
}

/**
 * Normalise un lieu détaillé vers le format DoctoNET
 */
function normaliseLieuDetail(detail, distKm) {
  const type = detecterType(detail.nom);
  const frais = detail.fraisACharge || [];
  const gratuit = frais.length === 0 || frais.some(f => f.toLowerCase().includes("gratuit"));

  return {
    id:          detail.id || "",
    nom:         detail.nom || "",
    adresse:     detail.adresse || "",
    code_postal: detail.codePostal || "",
    ville:       detail.commune || detail.ville || "",
    telephone:   detail.telephone || "",
    email:       detail.courriel || "",
    site:        detail.siteWeb || "",
    horaires:    formatHoraires(detail.horaires || detail.osmOpeningHours || ""),
    description: detail.description || detail.presentationResume || "",
    gratuit,
    services:    detectServices(detail),
    publics:     detail.publicsSpecifiques || [],
    distance_km: Math.round(distKm * 10) / 10,
    type,
    source:      "societenumerique",
  };
}

// ── Handler principal ─────────────────────────────────────────────────────────

export async function onRequestGet({ request }) {
  const url  = new URL(request.url);
  const cp   = (url.searchParams.get("cp")   || "").trim();
  const type = (url.searchParams.get("type") || "ateliers").trim();

  if (!cp) return errorResponse("Paramètre 'cp' requis.");
  if (!/^\d{5}$/.test(cp)) return errorResponse("Code postal invalide.");

  const typesValides = ["ateliers", "france_services", "acces_libre", "all"];
  if (!typesValides.includes(type)) return errorResponse(`Type invalide : ${typesValides.join(", ")}.`);

  // ── Lieux DoctoNET
  // Quand type="all", on fusionne toutes les catégories (LIEUX_DOCTONET["all"] n'existe pas)
  const poolDoctonet = type === 'all'
    ? [
        ...(LIEUX_DOCTONET.ateliers       || []),
        ...(LIEUX_DOCTONET.france_services || []),
        ...(LIEUX_DOCTONET.acces_libre     || []),
      ]
    : (LIEUX_DOCTONET[type] || []);
  const lieuxDoctonet = poolDoctonet.filter(l => l.code_postal === cp);

  // ── CP → coordonnées
  let coords;
  try {
    coords = await codePostalToCoords(cp);
  } catch (err) {
    console.error("codePostalToCoords:", err.message);
    return jsonResponse({ cp, type, ville: "", total: lieuxDoctonet.length, doctonet_count: lieuxDoctonet.length, api_count: 0, results: lieuxDoctonet });
  }

  // ── Chunk → liste légère filtrée par distance et type
  let candidats = [];
  try {
    const chunk = await fetchChunk(coords.latitude, coords.longitude);
    candidats = chunk
      .map(l => ({
        ...l,
        _dist: distanceKm(coords.latitude, coords.longitude, l.latitude, l.longitude),
        _type: detecterType(l.nom),
      }))
      .filter(l => l._dist <= 20)
      .filter(l => type === "all" || l._type === type)
      .sort((a, b) => a._dist - b._dist)
      .slice(0, 20);
  } catch (err) {
    console.error("fetchChunk:", err.message);
    return jsonResponse({ cp, type, ville: coords.ville, total: lieuxDoctonet.length, doctonet_count: lieuxDoctonet.length, api_count: 0, results: lieuxDoctonet });
  }

  // ── Détails en parallèle (Promise.all)
  const details = await Promise.all(
    candidats.map(async l => {
      try {
        const detail = await fetchDetail(l.id);
        if (!detail) return null;
        return normaliseLieuDetail(detail, l._dist);
      } catch {
        return null;
      }
    })
  );

  const lieuxNationaux = details.filter(Boolean);

  // ── Fusion DoctoNET + nationaux
  // Déduplication par nom ET par id pour éviter les doublons dans tous les cas
  const vuNoms = new Set(lieuxDoctonet.map(l => l.nom.toLowerCase()));
  const vuIds  = new Set(lieuxDoctonet.map(l => l.id));
  const lieuxFiltres = lieuxNationaux.filter(l => !vuNoms.has(l.nom.toLowerCase()) && !vuIds.has(l.id));
  const results = [...lieuxDoctonet, ...lieuxFiltres];

  return jsonResponse({
    cp,
    type,
    ville: coords.ville,
    total: results.length,
    doctonet_count: lieuxDoctonet.length,
    api_count: lieuxFiltres.length,
    results,
  });
}
