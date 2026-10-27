/** The 400 every refused input gets: the schema check in app.ts and the few checks a handler keeps. */
export const invalidInput = (problems: string[]) => ({
  status: 400 as const,
  body: { error: "invalid_input", message: "Input is invalid", problems },
});
