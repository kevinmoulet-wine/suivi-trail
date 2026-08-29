# Contexte du projet — Suivi Trail

Application de suivi d'entraînement trail/ultra pour un coureur qui prépare
deux courses liées entre elles :
- **Salomon Eco Trail de Paris 50K** — 17 octobre 2026 (course "étape de préparation")
- **SaintéLyon 80K** — 29 novembre 2026 (objectif final)

L'EcoTrail est explicitement une étape de préparation pour la SaintéLyon (le plan
de la SaintéLyon intègre les semaines de préparation de l'EcoTrail).

## Stack

- React + Vite, un seul composant principal `src/App.jsx`
- `recharts` pour les graphiques, `papaparse` pour parser le CSV Garmin, `lucide-react` pour les icônes
- Persistance via `src/storage.js` (localStorage) — voir "Limites connues" plus bas

## Source des données

L'utilisateur exporte ses activités Garmin Connect via le script `scripts/export_garmin.py`
(utilise la lib `garminconnect`), qui produit un CSV avec ces colonnes :
`date, nom, type, distance_km, duree, allure_min_par_km, d_plus_m, d_moins_m,
fc_moyenne, fc_max, vitesse_moy_kmh, vitesse_max_kmh, calories, vo2max_estime,
cadence_moyenne, puissance_moyenne_w, temperature_moy_C,
training_effect_aerobie, training_effect_anaerobie, trace_gps`.

`trace_gps` est le tracé GPS simplifié (jusqu'à `TRACK_MAX_POINTS` points), encodé en une
cellule `"lat,lon;lat,lon;..."` — vide si l'activité n'a pas de GPS (ex: tapis de course).

Ce CSV est importé dans l'app (upload de fichier ou copier-coller) et parsé côté client.

## Modèle de données (state de `App.jsx`)

- `activities`: activités importées (voir colonnes ci-dessus, renommées en camelCase/français)
- `goals`: liste d'objectifs de course, chacun avec :
  - `nom, date, distance, dplus`
  - `isPrepFor`: id d'un autre objectif si celui-ci en est une étape de préparation
  - `targetKm, targetDplus`: volume total cible sur la période (auto-suggéré, ajustable)
  - `program.sessions`: **programme hebdomadaire récurrent défini par l'utilisateur**
    (jour, type de séance, km, D+, créneau horaire optionnel) — se répète à l'identique
    chaque semaine. C'est la source de vérité pour ce qui est réellement prévu (pas de
    génération automatique de séances).
  - `nominalTargets`: cibles chiffrées individuelles (ex: VO2max 51→55), avec type
    (`vo2max`, `allure`, `sortie_longue`, `custom`), valeur de départ et valeur cible
- `journal`: note de ressenti (1-10 + commentaire libre) par date d'activité

## Logique métier importante

1. **Plan par objectif** (`buildPlan` → `buildLeafPlan` / `buildPlanWithChild`) : découpe
   la période de préparation en phases (Base → Développement → Pic → Affûtage de 2 semaines),
   avec répartition d'un total km/D+ cible par semaine selon un poids par phase
   (`phaseWeight` / `distributeWeeklyTargets`).
2. **Programme vs besoin** (`ComparisonPanel` / `finalizePlan.phaseComparison`) : compare
   le programme hebdo fixe de l'utilisateur au besoin moyen par phase, et donne un verdict
   ("ok" / "insuffisant" / "excessif") + une recommandation d'ajustement qui **garde les
   mêmes créneaux** (proposer d'augmenter la séance la plus longue, pas d'en ajouter une).
3. **Score global %** (`computeGoalScore`) : compare le cumul réel (toutes activités
   importées depuis le début de la fenêtre de préparation) au cumul idéal à date (avec
   prorata pour la semaine en cours), pondéré : D+ 30% / volume 20% / sorties longues 20% /
   régularité 15% / tendance VO2max 15%. Si aucune séance n'est encore comparable, retourne
   `notStarted: true` (ne jamais afficher un faux 100%/0% dans ce cas — c'est un bug qu'on
   a déjà corrigé une fois, voir historique de conversation si besoin de contexte).
4. **Objectifs imbriqués** : quand un objectif B est `isPrepFor` d'un objectif A, le plan de
   A intègre les semaines de B (marquées "partagé"), une semaine de course, une semaine de
   récupération, puis reprend son propre cycle Développement/Pic/Affûtage.

## Limites connues à améliorer

- **Stockage** : `localStorage` est local au navigateur — pas de sync entre appareils.
  Si l'utilisateur veut accéder à ses données depuis plusieurs appareils, il faudra un vrai
  backend (ex: Supabase) — `src/storage.js` est le seul endroit à changer, l'interface
  (`get/set/delete`) est déjà découplée du reste de l'app pour faciliter ce remplacement.
- Les heuristiques de volume total suggéré (`finalizePlan`) sont approximatives
  (basées sur la distance/D+ de la course) — l'utilisateur les ajuste manuellement,
  mais elles pourraient être affinées avec plus de données réelles.
- Pas de tests automatisés pour l'instant.
- Design actuel volontairement provisoire (thème sombre trail/montagne) — l'utilisateur a
  dit vouloir retravailler le design après avoir stabilisé la logique de données.

## Conventions

- Toute l'interface est en français.
- Le style visuel actuel utilise des tokens de couleur définis en haut de `App.jsx` (objet `C`)
  et des styles inline plutôt que des classes Tailwind arbitraires (contrainte héritée de
  l'environnement d'origine — libre de changer d'approche CSS si besoin).
