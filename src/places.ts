// Campus places: find a place inside free text, and estimate a walk between two points.
// Walking times are a hard rule (code decides, never the model).

import type { DatabaseSync } from "node:sqlite";

export interface Place {
  id: number;
  name: string;
  lat: number;
  lng: number;
  kind: string | null;
}

/** Lowercase, drop apostrophes, turn "&" into "and" and everything else that isn't a letter or digit into a space. */
export function normalizePlaceText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’'`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseNicknames(raw: unknown): string[] {
  try {
    const v = JSON.parse(typeof raw === "string" ? raw : "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Finds a campus place named inside free text ("near leavey", "by the village dining hall", "taper hall 2nd floor").
 * Names and nicknames match on whole words only, so "sal" never matches inside "salad".
 * The longest match wins ("village dining hall" beats "village"); ties go to the one mentioned first.
 */
export function findPlace(db: DatabaseSync, text: string): Place | null {
  const haystack = ` ${normalizePlaceText(text ?? "")} `;
  if (haystack.trim() === "") return null;
  const rows = db.prepare("SELECT id, name, nicknames, lat, lng, kind FROM campus_places ORDER BY id").all() as Record<string, unknown>[];

  let best: { place: Place; length: number; at: number } | null = null;
  for (const r of rows) {
    const labels = [r.name as string, ...parseNicknames(r.nicknames)];
    for (const label of labels) {
      const needle = normalizePlaceText(label);
      if (!needle) continue;
      const at = haystack.indexOf(` ${needle} `);
      if (at === -1) continue;
      if (!best || needle.length > best.length || (needle.length === best.length && at < best.at)) {
        best = {
          place: { id: r.id as number, name: r.name as string, lat: r.lat as number, lng: r.lng as number, kind: (r.kind as string) ?? null },
          length: needle.length,
          at,
        };
      }
    }
  }
  return best ? best.place : null;
}

const EARTH_RADIUS_M = 6371000;
const METERS_PER_MINUTE = 80;
/** Paths bend around buildings, so the straight line is stretched by this much. */
const PATH_FACTOR = 1.25;

function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Whole minutes to walk from a to b: straight-line distance x 1.25, at 80 m per minute, rounded up, never less than 1. */
export function walkingMinutes(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const minutes = (haversineMeters(a, b) * PATH_FACTOR) / METERS_PER_MINUTE;
  return Math.max(1, Math.ceil(minutes));
}
