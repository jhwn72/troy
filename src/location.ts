// Each student's last known location (John's decision, Nov 14 evening: "Location is kept").
//
// This file is the only reader and writer of users.lastLat / lastLng / lastLocationAt / lastLocationSource.
// The columns are deliberately not on the shared User type, so nothing that passes a User around
// (dashboards, prompts, other flows) can carry coordinates by accident.
//
// Hard rules:
// - A saved location is only ever used for the student's own walking times and their own "what do u know about me".
// - It is never put in a text to another student and never returned by the web API.
// - Nothing here is sent to the model.

import type { DatabaseSync } from "node:sqlite";
import type { User } from "./types.ts";
import { findPlace } from "./places.ts";

/** How Troy learned it: a Find My share bubble, a dropped pin, or the student saying where they are. */
export type LocationSource = "find_my" | "pin" | "asked";

/** A saved fix older than this is still used, but worded as "from where u last shared". Exactly 3 hours is not stale yet. */
export const LOCATION_STALE_MS = 3 * 60 * 60 * 1000;
/** A fix this close to a campus place is described by that place's name. */
export const NEAR_PLACE_METERS = 150;

const SOURCES: readonly string[] = ["find_my", "pin", "asked"];

export interface UserLocation {
  lat: number;
  lng: number;
  /** When the fix was taken. Null for a usual spot. */
  at: number | null;
  source: LocationSource | "usual_spot";
  /** True when a saved fix is more than 3 hours old. Always false for a usual spot. */
  stale: boolean;
  /** For a usual spot only: the spot as the student wrote it, lowercased ("tcc"). */
  spot?: string;
}

const validCoords = (loc: { lat: number; lng: number } | null | undefined): loc is { lat: number; lng: number } =>
  !!loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng) && Math.abs(loc.lat) <= 90 && Math.abs(loc.lng) <= 180;

/**
 * Replace the student's saved fix. `at` is when the fix was taken (defaults to now; a time in the future is clamped to now).
 * Bad coordinates are ignored, so a broken payload can never wipe or corrupt a good fix.
 */
export function saveUserLocation(db: DatabaseSync, userId: number, loc: { lat: number; lng: number }, source: LocationSource, at: number = Date.now()): void {
  if (!validCoords(loc) || !SOURCES.includes(source)) return;
  const now = Date.now();
  const when = Number.isFinite(at) ? Math.min(at, now) : now;
  db.prepare("UPDATE users SET lastLat = ?, lastLng = ?, lastLocationAt = ?, lastLocationSource = ? WHERE id = ?").run(loc.lat, loc.lng, Math.round(when), source, userId);
}

/** Erase the saved fix ("forget my location", STOP, "delete my data"). Usual spots are a separate setting and stay. */
export function forgetUserLocation(db: DatabaseSync, userId: number): void {
  db.prepare("UPDATE users SET lastLat = NULL, lastLng = NULL, lastLocationAt = NULL, lastLocationSource = NULL WHERE id = ?").run(userId);
}

function savedFix(db: DatabaseSync, userId: number): { lat: number; lng: number; at: number; source: LocationSource } | null {
  const r = db.prepare("SELECT lastLat, lastLng, lastLocationAt, lastLocationSource FROM users WHERE id = ?").get(userId) as
    | { lastLat: number | null; lastLng: number | null; lastLocationAt: number | null; lastLocationSource: string | null }
    | undefined;
  if (!r || r.lastLat === null || r.lastLng === null) return null;
  const loc = { lat: Number(r.lastLat), lng: Number(r.lastLng) };
  if (!validCoords(loc)) return null;
  const source = (SOURCES.includes(r.lastLocationSource ?? "") ? r.lastLocationSource : "asked") as LocationSource;
  // A fix with no time on it can't be shown to be recent, so it counts as old.
  return { ...loc, at: r.lastLocationAt === null ? 0 : Number(r.lastLocationAt), source };
}

/**
 * The best place Troy has for this student, for their own walking times:
 * the saved fix first (stale when older than 3 hours, still returned), else the first usual spot that
 * findPlace resolves, else null.
 */
export function getUserLocation(db: DatabaseSync, user: User, now: number = Date.now()): UserLocation | null {
  const fix = savedFix(db, user.id);
  if (fix) return { lat: fix.lat, lng: fix.lng, at: fix.at, source: fix.source, stale: now - fix.at > LOCATION_STALE_MS };
  for (const spot of user.usualSpots ?? []) {
    if (typeof spot !== "string") continue;
    const place = findPlace(db, spot);
    if (place) return { lat: place.lat, lng: place.lng, at: null, source: "usual_spot", stale: false, spot: spot.toLowerCase().replace(/\s+/g, " ").trim() };
  }
  return null;
}

const EARTH_RADIUS_M = 6371000;

/** Straight-line meters between two points. */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Lowercased name of the closest campus place within 150 m, else null. */
export function nearestPlaceName(db: DatabaseSync, loc: { lat: number; lng: number }): string | null {
  const rows = db.prepare("SELECT name, lat, lng FROM campus_places ORDER BY id").all() as { name: string; lat: number; lng: number }[];
  let best: { name: string; meters: number } | null = null;
  for (const r of rows) {
    const meters = distanceMeters(loc, { lat: r.lat, lng: r.lng });
    if (meters <= NEAR_PLACE_METERS && (!best || meters < best.meters)) best = { name: r.name, meters };
  }
  return best ? best.name.toLowerCase() : null;
}

/** "just now", "12 min ago", "3 hr ago", "2 days ago". */
export function ageText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/**
 * What the student may be told about their own saved fix: a place name (never coordinates) and its age.
 * Null when nothing is saved. Usual spots are not a saved location and are not described here.
 * Only ever for the student's own chat.
 */
export function describeSavedLocation(db: DatabaseSync, userId: number, now: number = Date.now()): { place: string; age: string; source: LocationSource; stale: boolean } | null {
  const fix = savedFix(db, userId);
  if (!fix) return null;
  const near = nearestPlaceName(db, fix);
  return { place: near ? `near ${near}` : "a spot off campus", age: ageText(now - fix.at), source: fix.source, stale: now - fix.at > LOCATION_STALE_MS };
}
