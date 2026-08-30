import { z } from 'zod'

// be10: workout-logs/index.ts was the only one of 24 functions with zero
// schema validation -- truthy-checks only (`if (!durationSec) ...`), so a
// genuine `durationSec: 0` was rejected while `durationSec: "abc"` sailed
// through to Postgres and surfaced as an opaque 500. Mirrors
// todo-contract.ts's shape/naming (nullableText, superRefine for
// cross-field ordering) rather than inventing a second validation style.
//
// Enum values match WorkoutModel.swift's `WorkoutLog.Source` and
// `WorkoutActivityType` raw values exactly (WorkoutAPI.swift's
// WorkoutLogCreateRequestDTO sends `.rawValue` for both) -- not free text.
const workoutSourceEnum = z.enum(['healthkit', 'manual'])
const workoutActivityTypeEnum = z.enum([
  'running',
  'cycling',
  'swimming',
  'strengthTraining',
  'yoga',
  'hiit',
  'walking',
  'other',
])

const nullableText = (maximum: number) => z.string().max(maximum).nullable().optional()

// Size cap on the exercises JSONB (be10) -- previously unbounded, so a
// client bug or a hostile payload could store an arbitrarily large blob
// per workout with no server-side limit at all.
const exerciseSetSchema = z.object({
  id: z.string().max(100),
  name: z.string().trim().min(1).max(200),
  sets: z.number().int().min(0).max(999),
  reps: z.number().int().min(0).max(9999).nullable().optional(),
  weightKg: z.number().min(0).max(2000).nullable().optional(),
  durationSeconds: z.number().int().min(0).max(86_400).nullable().optional(),
})
const exercisesSchema = z.array(exerciseSetSchema).max(200).nullable().optional()

export const workoutLogCreateSchema = z.object({
  hkUuid: nullableText(200),
  source: workoutSourceEnum.default('manual'),
  activityType: workoutActivityTypeEnum,
  startedAt: z.iso.datetime({ offset: true }),
  endedAt: z.iso.datetime({ offset: true }),
  // int, not truthy -- a 0-second workout (a HealthKit sample that starts
  // and ends the same instant) is a real value, not a missing one.
  durationSec: z.number().int().min(0).max(86_400),
  distanceM: z.number().min(0).max(1_000_000).nullable().optional(),
  calories: z.number().min(0).max(100_000).nullable().optional(),
  avgHeartRate: z.number().min(0).max(300).nullable().optional(),
  routeImageUrl: nullableText(2048),
  photoUrl: nullableText(2048),
  scheduledDate: z.iso.date(),
  locationName: nullableText(200),
  notes: z.string().max(2000).default(''),
  exercises: exercisesSchema,
}).superRefine((value, context) => {
  if (Date.parse(value.endedAt) < Date.parse(value.startedAt)) {
    context.addIssue({
      code: 'custom',
      path: ['endedAt'],
      message: 'endedAt must not precede startedAt',
    })
  }
})

export const workoutLogUpdateDetailsSchema = z.object({
  locationName: nullableText(200),
  notes: z.string().max(2000).default(''),
  exercises: exercisesSchema,
})
