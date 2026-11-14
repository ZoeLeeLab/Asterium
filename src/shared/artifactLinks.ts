/** Links that can be looked up as a delivered local file, never navigated to. */
export function isLocalArtifactLink(href: string) {
  return /^(?:file:\/\/\/|\/?[a-z]:[\\/]|\/(?![\\/]))/i.test(href);
}
