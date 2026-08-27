# Suivi Trail

Appli de suivi d'entraînement trail construite avec Claude, migrée depuis un
artifact Claude.ai vers un vrai projet pour continuer son développement avec
Claude Code.

Voir `CLAUDE.md` pour le contexte complet (logique métier, modèle de données,
limites connues) — Claude Code le lit automatiquement.

## Lancer en local

```bash
npm install
npm run dev
```

## Déploiement

Projet Vite standard — déployable tel quel sur Vercel, Netlify, ou équivalent
(`npm run build` produit le dossier `dist/`).

## Données

Les activités sont exportées depuis Garmin Connect via `scripts/export_garmin.py`
puis importées dans l'app (upload ou copier-coller du CSV généré).
