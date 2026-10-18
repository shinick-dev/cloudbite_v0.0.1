// Catalogue size and project team size are separate bounds. Leaf module with no imports, so the pool, routing,
// the harness and the browser console (type-only import of the literal types) share it without dependency cycles.
// The catalogue bound only caps how many roles may be listed and assessed; it is not a selection or capacity claim.

/** Upper bound on catalogue entries and on runnable roles Jev assesses for one question. */
export const CATALOGUE_MAX_ROLES = 200;
/** Upper bound on experts one project may select. Actor, concurrency, access and cost policies keep their own limits. */
export const PROJECT_MAX_EXPERTS = 100;

export type CatalogueMaxRoles = typeof CATALOGUE_MAX_ROLES;
export type ProjectMaxExperts = typeof PROJECT_MAX_EXPERTS;
