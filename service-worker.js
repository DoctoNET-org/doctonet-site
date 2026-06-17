/*
 * DoctoNET — Service Worker
 * ----------------------------------------------------------------------------
 * Stratégie : NETWORK-FIRST (« au fil de l'eau »)
 *
 *   1. On va TOUJOURS chercher la version fraîche en ligne d'abord.
 *   2. Si on l'obtient → on la montre ET on en garde une copie au passage.
 *   3. Si Internet est coupé → on ressort la copie en cache.
 *   4. Si aucune copie n'existe (page jamais visitée) → page de secours douce.
 *
 * Conséquence : publier un nouveau tutoriel ne demande JAMAIS de retoucher
 * ce fichier. La copie hors-ligne se met à jour seule à chaque visite connectée.
 *
 * Ce qu'on N'INTERCEPTE JAMAIS (toujours réseau direct, jamais de cache) :
 *   - /api/contact  (formulaire → Jira)
 *   - /api/search   (annuaire santé en direct)
 *   - /api/lieux    (carte nationale en direct)
 *
 * En cas de pépin : remplacer le contenu de ce fichier par celui du
 * kill switch (service-worker-killswitch.js) → désinstalle tout proprement.
 * ----------------------------------------------------------------------------
 */

// Version du cache. Pour purger les vieilles copies chez tout le monde,
// il suffit d'incrémenter ce numéro (ex. v2 → v3). Pas obligatoire pour
// afficher les nouveautés — network-first s'en charge tout seul.
const CACHE_VERSION = 'doctonet-v1';

// Page de secours servie quand une page jamais visitée est demandée hors-ligne.
const PAGE_SECOURS = '/offline.html';

// Fichiers mis en cache dès l'installation (le strict minimum pour le secours).
const PRECACHE = [
  PAGE_SECOURS,
];

// Chemins qui ne doivent JAMAIS passer par le cache (toujours le réseau direct).
const EXCLUSIONS = [
  '/api/contact',
  '/api/search',
  '/api/lieux',
];

/* --------------------------------------------------------------------------
 * INSTALLATION — on met en cache la seule page de secours.
 * ------------------------------------------------------------------------ */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      // On active la nouvelle version sans attendre la fermeture des onglets.
      .then(() => self.skipWaiting())
  );
});

/* --------------------------------------------------------------------------
 * ACTIVATION — on supprime les anciens caches (versions précédentes).
 * ------------------------------------------------------------------------ */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cles) => Promise.all(
        cles
          .filter((cle) => cle !== CACHE_VERSION)
          .map((cle) => caches.delete(cle))
      ))
      // On prend le contrôle des pages déjà ouvertes immédiatement.
      .then(() => self.clients.claim())
  );
});

/* --------------------------------------------------------------------------
 * INTERCEPTION DES REQUÊTES — le cœur de la stratégie network-first.
 * ------------------------------------------------------------------------ */
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // 1. On ne gère QUE les requêtes GET. Le reste (POST du formulaire, etc.)
  //    passe directement au réseau, sans interception.
  if (request.method !== 'GET') {
    return;
  }

  // 2. On ne gère QUE notre propre domaine. Les ressources externes
  //    (Google Fonts, GA4, etc.) passent directement au réseau.
  if (url.origin !== self.location.origin) {
    return;
  }

  // 3. EXCLUSIONS : les API ne sont jamais interceptées → réseau direct.
  if (EXCLUSIONS.some((chemin) => url.pathname.startsWith(chemin))) {
    return;
  }

  // 4. NETWORK-FIRST pour tout le reste (pages, CSS, images, manifest).
  event.respondWith(
    fetch(request)
      .then((reponseReseau) => {
        // Réseau OK → on garde une copie au passage (si réponse valide),
        // puis on renvoie la version fraîche.
        if (reponseReseau && reponseReseau.status === 200) {
          const copie = reponseReseau.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copie));
        }
        return reponseReseau;
      })
      .catch(() => {
        // Réseau coupé → on tente la copie en cache.
        return caches.match(request).then((copieCache) => {
          if (copieCache) {
            return copieCache;
          }
          // Aucune copie : pour une navigation (page HTML), on sert la
          // page de secours douce. Pour le reste (image manquante, etc.),
          // on laisse échouer silencieusement.
          if (request.mode === 'navigate') {
            return caches.match(PAGE_SECOURS);
          }
          return Response.error();
        });
      })
  );
});
