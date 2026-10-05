// A module-private capability passed only by the owner-authorized review route.
// JSON request bodies cannot create symbol properties.
export const BILLING_REVIEW_CREATE_CONTEXT = Symbol("billing-review-create-context");
