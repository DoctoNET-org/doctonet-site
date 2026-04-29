/**
 * DoctoNET — /api/lieux
 * Cloudflare Pages Function
 *
 * Stratégie :
 *   1. Code postal → coordonnées GPS via api-adresse.data.gouv.fr (public, sans token)
 *   2. Coordonnées → lieux via cartographie.societenumerique.gouv.fr/api/lieux/chunk (public, sans token)
 *   3. Lieux DoctoNET validés manuellement fusionnés en tête
 *
 * Route : GET /api/lieux?cp=75020&type=ateliers
 */

// ── Lieux DoctoNET embarqués directement (évite tout problème de fetch interne) ──
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
 * Étape 1 — Code postal → {latitude, longitude, ville}
 * API adresse.data.gouv.fr — publique, sans token
 */
async function codePostalToCoords(cp) {
  const url = `https://api-adresse.data.gouv.fr/search/?q=${cp}&type=municipality&limit=1`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`api-adresse HTTP ${res.status}`);
  const data = await res.json();
  const feature = data.features?.[0];
  if (!feature) throw new Error(`Aucune commune trouvée pour le CP ${cp}`);
  const [longitude, latitude] = feature.geometry.coordinates;
  const ville = feature.properties.city || feature.properties.label || "";
  const codePostal = feature.properties.postcode || cp;
  return { latitude, longitude, ville, codePostal };
}

/**
 * Étape 2 — Coordonnées → lieux via cartographie.societenumerique.gouv.fr
 * Endpoint découvert par reverse engineering — public, sans token
 */
async function fetchLieuxCarto(latitude, longitude) {
  const url = `https://cartographie.societenumerique.gouv.fr/api/lieux/chunk?latitude=${latitude}&longitude=${longitude}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 3600 },
  });
  if (!res.ok) throw new Error(`cartographie.societenumerique HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Calcule la distance en km entre deux points GPS (formule Haversine simplifiée)
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
 * Normalise un lieu cartographie vers le format DoctoNET
 */
function normaliseLieu(lieu, distKm) {
  return {
    id:          lieu.id || "",
    nom:         lieu.nom || "",
    adresse:     [lieu.adresse, lieu.commune].filter(Boolean).join(", "),
    code_postal: lieu.codePostal || "",
    ville:       lieu.commune || "",
    telephone:   lieu.telephone || "",
    email:       lieu.courriel || "",
    site:        lieu.siteWeb || "",
    horaires:    lieu.horaires || "",
    description: lieu.presentationResume || lieu.presentationDetail || "",
    gratuit:     true,
    services:    detectServices(lieu),
    distance_km: Math.round(distKm * 10) / 10,
    source:      "societenumerique",
  };
}

/**
 * Détecte les services à partir des données du lieu
 */
function detectServices(lieu) {
  const services = [];
  const desc = ((lieu.presentationResume || "") + " " + (lieu.presentationDetail || "")).toLowerCase();
  if (desc.includes("wifi") || desc.includes("wi-fi") || desc.includes("internet")) services.push("wifi");
  if (desc.includes("ordinateur") || desc.includes("poste") || desc.includes("materiel")) services.push("postes_libres");
  if (desc.includes("impression") || desc.includes("imprimer") || desc.includes("imprimante")) services.push("impression");
  if (desc.includes("scan") || desc.includes("numériser")) services.push("scanner");
  return services;
}

/**
 * Filtre les lieux par type demandé
 */
function filtrerParType(lieux, type) {
  if (type === "all") return lieux;

  // Mots-clés par type pour filtrer les noms
  const motsCles = {
    ateliers: ["atelier", "coop", "numérique", "inclusion", "médiation", "formation", "initiation", "espace public", "epn", "cyberbase", "maison de quartier", "centre social"],
    france_services: ["france services", "conseiller numérique", "maison de services", "msap", "cnfs"],
    acces_libre: ["bibliothèque", "médiathèque", "biblioth", "médiath", "ludothèque", "espace lecture"],
  };

  const mots = motsCles[type] || [];
  if (mots.length === 0) return lieux;

  return lieux.filter(l => {
    const texte = (l.nom + " " + l.description).toLowerCase();
    return mots.some(m => texte.includes(m));
  });
}

// ── Handler principal ─────────────────────────────────────────────────────────

export async function onRequestGet({ request }) {
  const url  = new URL(request.url);
  const cp   = (url.searchParams.get("cp") || "").trim();
  const type = (url.searchParams.get("type") || "ateliers").trim();

  // Validation
  if (!cp) return errorResponse("Paramètre 'cp' (code postal) requis.");
  if (!/^\d{5}$/.test(cp)) return errorResponse("Code postal invalide — 5 chiffres attendus.");

  const typesValides = ["ateliers", "france_services", "acces_libre", "all"];
  if (!typesValides.includes(type)) {
    return errorResponse(`Type invalide. Valeurs acceptées : ${typesValides.join(", ")}.`);
  }

  // ── Lieux DoctoNET — toujours en premier
  const lieuxDoctonet = (LIEUX_DOCTONET[type] || []).filter(l => l.code_postal === cp);

  // ── Étape 1 : CP → coordonnées
  let coords;
  try {
    coords = await codePostalToCoords(cp);
  } catch (err) {
    console.error("codePostalToCoords error:", err.message);
    // Même sans coordonnées, on retourne les lieux DoctoNET
    return jsonResponse({
      cp, type, ville: "",
      total: lieuxDoctonet.length,
      doctonet_count: lieuxDoctonet.length,
      api_count: 0,
      results: lieuxDoctonet,
      warning: "Impossible de géolocaliser ce code postal.",
    });
  }

  // ── Étape 2 : coordonnées → lieux nationaux
  let lieuxNationaux = [];
  try {
    const raw = await fetchLieuxCarto(coords.latitude, coords.longitude);

    // Calculer distance + filtrer à 15km max + trier par proximité
    const avecDistance = raw
      .map(l => ({
        ...normaliseLieu(l, distanceKm(coords.latitude, coords.longitude, l.latitude, l.longitude)),
        _lat: l.latitude,
        _lon: l.longitude,
      }))
      .filter(l => l.distance_km <= 15)
      .sort((a, b) => a.distance_km - b.distance_km);

    lieuxNationaux = filtrerParType(avecDistance, type).slice(0, 20);
  } catch (err) {
    console.error("fetchLieuxCarto error:", err.message);
  }

  // ── Fusion : DoctoNET en premier, dédoublonnage par nom
  const vus = new Set(lieuxDoctonet.map(l => l.nom.toLowerCase()));
  const lieuxFiltres = lieuxNationaux.filter(l => !vus.has(l.nom.toLowerCase()));
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
