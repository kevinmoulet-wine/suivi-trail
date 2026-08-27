// Petit wrapper qui imite l'API window.storage (utilisée dans les artifacts Claude.ai)
// mais persiste dans le localStorage du navigateur — pour que l'appli tourne en dehors
// de Claude.ai (Vercel, Netlify, ou en local).
// À terme, si tu veux que tes données soient accessibles depuis plusieurs appareils,
// remplace ceci par de vrais appels API vers un backend (ou Supabase / Firebase, etc.)

const storage = {
  async get(key) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return null;
      return { key, value: raw };
    } catch (e) {
      throw e;
    }
  },
  async set(key, value) {
    try {
      localStorage.setItem(key, value);
      return { key, value };
    } catch (e) {
      throw e;
    }
  },
  async delete(key) {
    try {
      localStorage.removeItem(key);
      return { key, deleted: true };
    } catch (e) {
      throw e;
    }
  },
};

export default storage;
