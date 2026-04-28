/**
 * DoctoNET — /api/lieux
 * Cloudflare Pages Function
 *
 * Interroge 3 sources publiques selon le type demandé :
 *   - ateliers       → API data·inclusion (cartographie médiation numérique)
 *   - france_services → API Conseillers Numériques France Services
 *   - acces_libre    → API data·inclusion (bibliothèques / médiathèques)
 *
 * Route : GET /api/lieux?cp=75017&type=ateliers
 *
 * Les lieux validés manuellement par DoctoNET (lieux-doctonet.json)
 * sont fusionnés en tête de résultats.
 *
 * Aucune variable d'environnement requise — APIs publiques sans clé.
 */

// ── Sources API ──────────────────────────────────────────────────────────────

// API data·inclusion — cartographie nationale médiation numérique
// Doc : https://api.data.inclusion.beta.gouv.fr/api/v0/docs
const DATA_INCLUSION_BASE = 'https://api.data.inclusion.beta.gouv.fr/api/v0';

// API Conseillers Numériques France Services
// Doc : https://api.conseiller-numerique.gouv.fr/
const CNFS_BASE = 'https://api.conseiller-numerique.gouv.fr';

// ── Thématiques data·inclusion par type ─────────────────────────────────────
// Valeurs officielles du schéma data·inclusion
const THEMATIQUES = {
  ateliers: [
    'numerique--acceder-a-du-materiel',
    'numerique--s-initier-aux-outils-numeriques',
    'numerique--approfondir-ma-culture-numerique',
  ],
  acces_libre: [
    'numerique--acceder-a-du-materiel',
    'numerique--acceder-a-internet',
  ],
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600', // cache 1h côté Cloudflare
    },
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

/**
 * Normalise un lieu data·inclusion vers le format DoctoNET.
 */
function normaliseLieuDataInclusion(lieu) {
  return {
    id:          lieu.id          || '',
    nom:         lieu.nom         || lieu.structure?.nom || '',
    adresse:     [lieu.adresse, lieu.complement_adresse].filter(Boolean).join(', '),
    code_postal: lieu.code_postal || '',
    ville:       lieu.commune     || '',
    telephone:   lieu.telephone   || '',
    email:       lieu.courriel    || '',
    site:        lieu.site_web    || lieu.structure?.site_web || '',
    horaires:    lieu.horaires_ouverture || '',
    description: lieu.presentation_resume || lieu.presentation_detail || '',
    photo:       '',
    gratuit:     lieu.frais_autres === 'gratuit' || lieu.frais === null || true,
    services:    detectServices(lieu),
    source:      'data-inclusion',
  };
}

/**
 * Normalise une permanence CNFS vers le format DoctoNET.
 */
function normalisePermanenceCNFS(p) {
  const structure = p.structureInfo || {};
  const adresseParts = [
    p.adresse?.numeroRue,
    p.adresse?.rue,
    p.adresse?.codePostal,
    p.adresse?.ville,
  ].filter(Boolean);

  return {
    id:          p._id            || '',
    nom:         structure.nom    || p.nomEnseigne || '',
    adresse:     adresseParts.join(', '),
    code_postal: p.adresse?.codePostal || '',
    ville:       p.adresse?.ville || '',
    telephone:   p.telephone      || structure.contact?.telephone || '',
    email:       p.email          || structure.contact?.email || '',
    site:        structure.siteWeb || '',
    horaires:    formatHorairesCNFS(p.horaires),
    description: 'Conseiller Numérique France Services — accompagnement aux démarches en ligne, accès aux services publics (CAF, CPAM, Pôle Emploi, impôts…).',
    photo:       '',
    gratuit:     true,
    services:    ['wifi', 'postes_libres'],
    source:      'cnfs',
  };
}

/**
 * Formate les horaires CNFS (tableau de créneaux) en chaîne lisible.
 */
function formatHorairesCNFS(horaires) {
  if (!horaires || !Array.isArray(horaires)) return '';
  const jours = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
  return horaires
    .map(h => {
      const jour = jours[h.jour] || '';
      const matin = h.matin ? `${h.matin.debut}–${h.matin.fin}` : '';
      const apresMidi = h.apresMidi ? `${h.apresMidi.debut}–${h.apresMidi.fin}` : '';
      return [jour, [matin, apresMidi].filter(Boolean).join(' / ')].filter(Boolean).join(' ');
    })
    .join(', ');
}

/**
 * Détecte les services disponibles à partir des données data·inclusion.
 */
function detectServices(lieu) {
  const services = [];
  const desc = (lieu.presentation_resume || '' + lieu.presentation_detail || '').toLowerCase();
  const thematiques = lieu.thematiques || [];

  if (desc.includes('wifi') || desc.includes('wi-fi') || desc.includes('internet')) {
    services.push('wifi');
  }
  if (
    desc.includes('ordinateur') || desc.includes('poste') ||
    thematiques.some(t => t.includes('materiel') || t.includes('internet'))
  ) {
    services.push('postes_libres');
  }
  if (desc.includes('impression') || desc.includes('imprimer') || desc.includes('imprimante')) {
    services.push('impression');
  }
  if (desc.includes('scan') || desc.includes('numériser')) {
    services.push('scanner');
  }
  return services;
}

// ── Chargement des lieux DoctoNET (JSON statique dans le dépôt) ──────────────

async function fetchLieuxDoctonet(env, cp, type) {
  try {
    // lieux-doctonet.json est servi statiquement par Cloudflare Pages
    const url = `${env.ASSETS?.fetch ? '' : 'https://www.doctonet.org'}/lieux-doctonet.json`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    const dataset = data[type] || [];
    return dataset.filter(l => l.code_postal === cp);
  } catch {
    return [];
  }
}

// ── Fetchers par type ────────────────────────────────────────────────────────

async function fetchAteliers(cp) {
  const thematiques = THEMATIQUES.ateliers.join(',');
  const url = `${DATA_INCLUSION_BASE}/lieux?code_postal=${cp}&thematiques=${encodeURIComponent(thematiques)}&page_size=50`;

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    cf: { cacheTtl: 3600 },
  });

  if (!res.ok) throw new Error(`data·inclusion ateliers : HTTP ${res.status}`);
  const data = await res.json();
  return (data.items || []).map(normaliseLieuDataInclusion);
}

async function fetchFranceServices(cp) {
  const url = `${CNFS_BASE}/permanences?codePostal=${cp}&limit=50`;

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    cf: { cacheTtl: 3600 },
  });

  if (!res.ok) throw new Error(`CNFS : HTTP ${res.status}`);
  const data = await res.json();

  // L'API renvoie soit un tableau directement, soit { data: [...] }
  const items = Array.isArray(data) ? data : (data.data || []);
  return items.map(normalisePermanenceCNFS);
}

async function fetchAccesLibre(cp) {
  const thematiques = THEMATIQUES.acces_libre.join(',');
  const url = `${DATA_INCLUSION_BASE}/lieux?code_postal=${cp}&thematiques=${encodeURIComponent(thematiques)}&page_size=50`;

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    cf: { cacheTtl: 3600 },
  });

  if (!res.ok) throw new Error(`data·inclusion accès libre : HTTP ${res.status}`);
  const data = await res.json();

  // Filtrer uniquement médiathèques, bibliothèques, EPN
  const motsCles = ['biblioth', 'médiath', 'espace public numérique', 'epn', 'cyb'];
  return (data.items || [])
    .filter(l => {
      const nom = (l.nom || l.structure?.nom || '').toLowerCase();
      return motsCles.some(m => nom.includes(m));
    })
    .map(normaliseLieuDataInclusion);
}

// ── Handler principal ─────────────────────────────────────────────────────────

export async function onRequestGet({ request, env }) {
  const url    = new URL(request.url);
  const cp     = (url.searchParams.get('cp') || '').trim();
  const type   = (url.searchParams.get('type') || 'ateliers').trim();

  // Validation
  if (!cp) return errorResponse("Paramètre 'cp' (code postal) requis.");
  if (!/^\d{5}$/.test(cp)) return errorResponse("Code postal invalide — 5 chiffres attendus.");

  const typesValides = ['ateliers', 'france_services', 'acces_libre'];
  if (!typesValides.includes(type)) {
    return errorResponse(`Type invalide. Valeurs acceptées : ${typesValides.join(', ')}.`);
  }

  try {
    // Requêtes en parallèle : API nationale + lieux DoctoNET
    const [lieuxNationaux, lieuxDoctonet] = await Promise.all([
      type === 'ateliers'        ? fetchAteliers(cp)
      : type === 'france_services' ? fetchFranceServices(cp)
      : fetchAccesLibre(cp),
      fetchLieuxDoctonet(env, cp, type),
    ]);

    // Fusion : lieux DoctoNET en premier (validés manuellement)
    // Dédoublonnage par nom+adresse pour éviter les doublons si un lieu est dans les deux sources
    const vus = new Set(lieuxDoctonet.map(l => `${l.nom}|${l.adresse}`));
    const lieuxFiltres = lieuxNationaux.filter(l => !vus.has(`${l.nom}|${l.adresse}`));

    const results = [...lieuxDoctonet, ...lieuxFiltres];

    return jsonResponse({
      cp,
      type,
      total: results.length,
      doctonet_count: lieuxDoctonet.length,
      results,
    });

  } catch (err) {
    // Fallback : si l'API nationale est indisponible, on renvoie au moins les lieux DoctoNET
    console.error('lieux.js error:', err.message);

    try {
      const lieuxDoctonet = await fetchLieuxDoctonet(env, cp, type);
      return jsonResponse({
        cp,
        type,
        total: lieuxDoctonet.length,
        doctonet_count: lieuxDoctonet.length,
        fallback: true,
        results: lieuxDoctonet,
      });
    } catch {
      return errorResponse("Service temporairement indisponible. Veuillez réessayer.", 503);
    }
  }
}
