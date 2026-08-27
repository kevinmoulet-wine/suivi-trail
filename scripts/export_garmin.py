#!/usr/bin/env python3
"""
Export des activités Garmin Connect vers un CSV exploitable
(allure, D+, FC, VO2max, calories...) pour analyser ta progression
ou ajuster un programme de course.

Installation :
    pip install garminconnect

Utilisation :
    python export_garmin.py
    (il te demandera ton email et mot de passe Garmin, rien n'est stocké
     ni envoyé ailleurs qu'à Garmin lui-même)

Options utiles (modifie les constantes ci-dessous) :
    - LIMIT : nombre d'activités à récupérer (les plus récentes en premier)
    - ACTIVITY_TYPE_FILTER : ne garder que certains types (ex: "running")
"""

import csv
import getpass
import sys
from datetime import datetime

try:
    from garminconnect import Garmin
except ImportError:
    sys.exit("Lib manquante. Installe-la avec : pip install garminconnect")

# ---- Config ----
LIMIT = 200  # nombre d'activités récentes à récupérer
ACTIVITY_TYPE_FILTER = None  # ex: "running" pour ne garder que la course à pied, None = tout
OUTPUT_FILE = "garmin_export.csv"


def m_to_km(m):
    return round(m / 1000, 2) if m else None


def sec_to_pace(distance_m, duration_s):
    """Retourne l'allure en min/km, format mm:ss."""
    if not distance_m or not duration_s:
        return None
    pace_s_per_km = duration_s / (distance_m / 1000)
    minutes = int(pace_s_per_km // 60)
    seconds = int(pace_s_per_km % 60)
    return f"{minutes}:{seconds:02d}"


def sec_to_hms(duration_s):
    if not duration_s:
        return None
    h = int(duration_s // 3600)
    m = int((duration_s % 3600) // 60)
    s = int(duration_s % 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def main():
    email = input("Email Garmin Connect : ").strip()
    password = getpass.getpass("Mot de passe Garmin Connect : ")

    print("Connexion à Garmin Connect...")
    try:
        client = Garmin(email, password)
        client.login()
    except Exception as e:
        sys.exit(f"Échec de connexion : {e}")

    print(f"Récupération des {LIMIT} dernières activités...")
    activities = client.get_activities(0, LIMIT)

    rows = []
    for act in activities:
        act_type = act.get("activityType", {}).get("typeKey", "")
        if ACTIVITY_TYPE_FILTER and ACTIVITY_TYPE_FILTER not in act_type:
            continue

        distance_m = act.get("distance")
        duration_s = act.get("duration")

        rows.append({
            "date": act.get("startTimeLocal", "")[:10],
            "nom": act.get("activityName", ""),
            "type": act_type,
            "distance_km": m_to_km(distance_m),
            "duree": sec_to_hms(duration_s),
            "allure_min_par_km": sec_to_pace(distance_m, duration_s),
            "d_plus_m": act.get("elevationGain"),
            "d_moins_m": act.get("elevationLoss"),
            "fc_moyenne": act.get("averageHR"),
            "fc_max": act.get("maxHR"),
            "vitesse_moy_kmh": round(act.get("averageSpeed", 0) * 3.6, 2) if act.get("averageSpeed") else None,
            "vitesse_max_kmh": round(act.get("maxSpeed", 0) * 3.6, 2) if act.get("maxSpeed") else None,
            "calories": act.get("calories"),
            "vo2max_estime": act.get("vO2MaxValue"),
            "cadence_moyenne": act.get("averageRunningCadenceInStepsPerMinute"),
            "puissance_moyenne_w": act.get("avgPower"),
            "temperature_moy_C": act.get("minTemperature"),
            "training_effect_aerobie": act.get("aerobicTrainingEffect"),
            "training_effect_anaerobie": act.get("anaerobicTrainingEffect"),
        })

    if not rows:
        print("Aucune activité trouvée avec ces critères.")
        return

    with open(OUTPUT_FILE, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)

    print(f"✅ {len(rows)} activités exportées dans {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
