/**
 * firestore-service.js — Firestore data operations for SHATTERED
 *
 * Replaces direct Firebase Realtime Database calls from app.js.
 * Uses Firestore for track metadata, lyrics, collabs, posts, and user profiles.
 * Audio blobs remain in local IndexedDB; metadata goes to Firestore.
 *
 * Security note: every write operation tags the document with the
 * authenticated user's UID so Firestore Security Rules can enforce ownership.
 */

import {
  getFirestore,
  collection,
  doc,
  addDoc,
  setDoc,
  deleteDoc,
  getDocs,
  getDoc,
  updateDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  where,
  increment,
  arrayUnion,
} from "https://www.gstatic.com/firebasejs/11.9.1/firebase-firestore.js";
import { getApps, initializeApp } from "https://www.gstatic.com/firebasejs/11.9.1/firebase-app.js";
import { firebaseConfig }         from "./firebase-config.js";

/* ── Singleton Firestore instance ────────────────────────────────────────── */
let _db = null;

function getDB() {
  if (_db) return _db;
  const apps = getApps();
  const app  = apps.length ? apps[0] : initializeApp(firebaseConfig);
  _db = getFirestore(app);
  return _db;
}

/* ── Generic helpers ─────────────────────────────────────────────────────── */

/**
 * Subscribe to a top-level collection, sorted by createdAt desc.
 *
 * For the "tracks" collection the Firestore Security Rule only allows reads
 * of documents whose publicationStatus == "published" (or owned by the
 * requesting user). A query that could return non-published documents will
 * be rejected entirely by Firestore for unsigned/unowned reads. We therefore
 * add a `where("publicationStatus","==","published")` filter for "tracks" so
 * the query always satisfies the security rule for public visitors.
 */
export function subscribeCollection(collectionName, callback) {
  try {
    const db = getDB();

    // Build query constraints — tracks require a publicationStatus filter
    // so that the Firestore security rule is satisfied for signed-out visitors.
    const constraints = [orderBy("createdAt", "desc")];
    if (collectionName === "tracks") {
      constraints.unshift(where("publicationStatus", "==", "published"));
    }

    const q = query(collection(db, collectionName), ...constraints);
    return onSnapshot(q, snap => {
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(docs);
    }, err => {
      console.warn(`Firestore listener [${collectionName}] error:`, err);
      callback([]);
    });
  } catch (err) {
    console.warn(`Could not subscribe to Firestore [${collectionName}]:`, err);
    return () => {}; // no-op unsubscribe
  }
}

/** Write (merge) a document. */
export async function fsSet(collectionName, id, data) {
  const db = getDB();
  await setDoc(doc(db, collectionName, id), {
    ...data,
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

/** Delete a document. */
export async function fsDelete(collectionName, id) {
  const db = getDB();
  await deleteDoc(doc(db, collectionName, id));
}

/* ── Tracks ──────────────────────────────────────────────────────────────── */

/**
 * Save track metadata to Firestore.
 * Audio blob stays in local IndexedDB — never written to Firestore.
 */
export async function saveTrackMeta(trackMeta, ownerUid) {
  const db   = getDB();
  const data = {
    ...trackMeta,
    ownerUid,
    publicationStatus: "published",
    createdAt:         serverTimestamp(),
    updatedAt:         serverTimestamp(),
  };
  await setDoc(doc(db, "tracks", trackMeta.id), data);
}

/** Delete a track (only if caller is the owner — enforced by Security Rules). */
export async function deleteTrack(trackId) {
  await fsDelete("tracks", trackId);
}

/* ── Lyrics ──────────────────────────────────────────────────────────────── */

export async function saveLyrics(item, ownerUid) {
  const db = getDB();
  await setDoc(doc(db, "lyrics", item.id), {
    ...item,
    ownerUid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function deleteLyrics(id) {
  await fsDelete("lyrics", id);
}

/* ── Collaborations ──────────────────────────────────────────────────────── */

export async function saveCollab(item, ownerUid) {
  const db = getDB();
  await setDoc(doc(db, "collabs", item.id), {
    ...item,
    ownerUid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function deleteCollab(id) {
  await fsDelete("collabs", id);
}

/* ── Community posts ─────────────────────────────────────────────────────── */

export async function savePost(item, ownerUid) {
  const db = getDB();
  await setDoc(doc(db, "posts", item.id), {
    ...item,
    ownerUid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function deletePost(id) {
  await fsDelete("posts", id);
}

export async function likePost(id) {
  const db = getDB();
  await updateDoc(doc(db, "posts", id), {
    likes: increment(1),
  });
}

/* ── User profiles ───────────────────────────────────────────────────────── */

/** Fetch the public profile of any user by their UID. */
export async function getUserProfile(uid) {
  const db = getDB();
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/** Update the authenticated user's own editable profile fields. */
export async function updateOwnProfile(uid, { displayName, bio, photoURL }) {
  const db   = getDB();
  const data = { updatedAt: serverTimestamp() };
  if (displayName !== undefined) data.displayName = displayName;
  if (bio         !== undefined) data.bio         = bio;
  if (photoURL    !== undefined) data.photoURL    = photoURL;
  await setDoc(doc(db, "users", uid), data, { merge: true });
}

/* ── Private messaging ───────────────────────────────────────────────────── */

/**
 * Subscribe to all conversations the given user is a member of.
 * Returns an unsubscribe function.
 */
export function subscribeConversations(uid, callback) {
  try {
    const db = getDB();
    const q = query(
      collection(db, "conversations"),
      where("memberUids", "array-contains", uid),
      orderBy("updatedAt", "desc")
    );
    return onSnapshot(q, snap => {
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(docs);
    }, err => {
      console.warn("Firestore conversations listener error:", err);
      callback([]);
    });
  } catch (err) {
    console.warn("Could not subscribe to conversations:", err);
    return () => {};
  }
}

/**
 * Subscribe to messages within a specific conversation.
 * Returns an unsubscribe function.
 */
export function subscribeMessages(conversationId, callback) {
  try {
    const db = getDB();
    const q = query(
      collection(db, "conversations", conversationId, "messages"),
      orderBy("createdAt", "asc")
    );
    return onSnapshot(q, snap => {
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(docs);
    }, err => {
      console.warn("Firestore messages listener error:", err);
      callback([]);
    });
  } catch (err) {
    console.warn("Could not subscribe to messages:", err);
    return () => {};
  }
}

/**
 * Create a new one-to-one or group conversation.
 * memberUids must include the current user's uid.
 * Returns the new conversation document id.
 */
export async function createConversation(memberUids, name = "") {
  const db = getDB();
  const ref = doc(collection(db, "conversations"));
  await setDoc(ref, {
    memberUids,
    name: name || "",
    createdAt:  serverTimestamp(),
    updatedAt:  serverTimestamp(),
    lastMessage: "",
  });
  return ref.id;
}

/**
 * Send a message in a conversation.
 * Caller must be a member — enforced by Firestore rules.
 */
export async function sendMessage(conversationId, senderUid, senderName, body) {
  const db  = getDB();
  const msgRef = doc(collection(db, "conversations", conversationId, "messages"));
  await setDoc(msgRef, {
    senderUid,
    senderName,
    body,
    createdAt: serverTimestamp(),
    editedAt:  null,
    deleted:   false,
  });
  // Update parent conversation's updatedAt and lastMessage preview
  await updateDoc(doc(db, "conversations", conversationId), {
    updatedAt:   serverTimestamp(),
    lastMessage: body.slice(0, 80),
  });
  return msgRef.id;
}

/**
 * Edit the body of a message the caller sent.
 * Firestore rules require the caller be a conversation member.
 */
export async function editMessage(conversationId, messageId, newBody) {
  const db = getDB();
  await updateDoc(
    doc(db, "conversations", conversationId, "messages", messageId),
    { body: newBody, editedAt: serverTimestamp() }
  );
}

/**
 * Soft-delete a message (marks deleted:true, clears body).
 */
export async function deleteMessage(conversationId, messageId) {
  const db = getDB();
  await updateDoc(
    doc(db, "conversations", conversationId, "messages", messageId),
    { deleted: true, body: "", editedAt: serverTimestamp() }
  );
}

/**
 * Look up a user document by email address.
 * Returns the user object ({ id, ...data }) or null if not found.
 */
export async function getUserByEmail(email) {
  const db  = getDB();
  const q   = query(collection(db, "users"), where("email", "==", email));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() };
}
