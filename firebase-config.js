/**
 * firebase-config.js
 * Shared Firebase configuration for SHATTERED PWA.
 * Exported as an ES module so every other module can import from here.
 *
 * IMPORTANT: The values below are the Firebase client-side API keys.
 * These are safe to include in frontend code — they identify the Firebase
 * project and are restricted via Firebase Security Rules and authorized
 * domain settings. Never place server-side service-account keys or admin
 * credentials here.
 *
 * Add all deployment domains to:
 *   Firebase Console → Authentication → Settings → Authorized domains
 *
 * Required authorized domains for this project:
 *   - localhost                          (local development)
 *   - legend200711.github.io             (GitHub Pages)
 *   - remix-studio-4bf8a.firebaseapp.com (Firebase default hosting)
 */

export const firebaseConfig = {
  apiKey:            "AIzaSyB2M8sgU__2s0oVa5y4-s1S294aP5CBdeQ",
  authDomain:        "remix-studio-4bf8a.firebaseapp.com",
  databaseURL:       "https://remix-studio-4bf8a-default-rtdb.firebaseio.com",
  projectId:         "remix-studio-4bf8a",
  storageBucket:     "remix-studio-4bf8a.firebasestorage.app",
  messagingSenderId: "220851113113",
  appId:             "1:220851113113:web:bb3cd4e44f478d3925fc08",
  measurementId:     "G-GM0JCC3BGW"
};
