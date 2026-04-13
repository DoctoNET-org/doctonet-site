/**
 * data.js — Répertoire des professionnels de santé DoctoNET
 *
 * Structure de chaque entrée :
 * {
 *   id        : identifiant unique (entier)
 *   name      : nom du cabinet ou du praticien
 *   specialty : spécialité médicale
 *   address   : adresse complète affichée à l'utilisateur
 *   phone     : numéro de téléphone (format lisible)
 *   lat       : latitude GPS (obtenue via maps.google.fr ou geoportail.fr)
 *   lng       : longitude GPS
 * }
 *
 * Pour ajouter un professionnel :
 * 1. Copier un bloc ci-dessous
 * 2. Incrémenter l'id
 * 3. Remplir les champs
 * 4. Trouver lat/lng sur https://www.geoportail.gouv.fr (clic droit → "Adresse/Coordonnées du lieu")
 */

export const professionals = [

  // ── Paris ──────────────────────────────────────────────────────────────────

  {
    id: 1,
    name: "Cabinet médical Paris 17",
    specialty: "Médecin généraliste",
    address: "12 rue de Lévis, 75017 Paris",
    phone: "01 02 03 04 05",
    lat: 48.8840,
    lng: 2.3219
  },
  {
    id: 2,
    name: "Centre de santé Montmartre",
    specialty: "Médecin généraliste",
    address: "8 rue Lepic, 75018 Paris",
    phone: "01 06 07 08 09",
    lat: 48.8920,
    lng: 2.3435
  },
  {
    id: 3,
    name: "Cabinet de cardiologie Opéra",
    specialty: "Cardiologue",
    address: "22 boulevard des Capucines, 75009 Paris",
    phone: "01 40 00 00 01",
    lat: 48.8706,
    lng: 2.3326
  },

  // ── Lyon ───────────────────────────────────────────────────────────────────

  {
    id: 4,
    name: "Cabinet médical Bellecour",
    specialty: "Médecin généraliste",
    address: "5 place Bellecour, 69002 Lyon",
    phone: "04 72 00 00 01",
    lat: 45.7578,
    lng: 4.8320
  },
  {
    id: 5,
    name: "Centre de santé Croix-Rousse",
    specialty: "Pédiatre",
    address: "3 grande rue de la Croix-Rousse, 69004 Lyon",
    phone: "04 72 00 00 02",
    lat: 45.7750,
    lng: 4.8280
  },

  // ── Marseille ──────────────────────────────────────────────────────────────

  {
    id: 6,
    name: "Cabinet médical Vieux-Port",
    specialty: "Médecin généraliste",
    address: "10 quai du Port, 13002 Marseille",
    phone: "04 91 00 00 01",
    lat: 43.2965,
    lng: 5.3698
  },

  // ── Bordeaux ───────────────────────────────────────────────────────────────

  {
    id: 7,
    name: "Maison de santé Saint-Pierre",
    specialty: "Médecin généraliste",
    address: "14 place du Parlement, 33000 Bordeaux",
    phone: "05 56 00 00 01",
    lat: 44.8378,
    lng: -0.5792
  },

  // ── Toulouse ───────────────────────────────────────────────────────────────

  {
    id: 8,
    name: "Cabinet médical Capitole",
    specialty: "Médecin généraliste",
    address: "2 place du Capitole, 31000 Toulouse",
    phone: "05 61 00 00 01",
    lat: 43.6047,
    lng: 1.4442
  }

];
