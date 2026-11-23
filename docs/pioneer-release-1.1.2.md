# Pioneer CLI 1.1.2

Pioneer CLI discovers Beast's GLM-5.3 Flash through Alpha using your Pioneer
credential. Run `pioneer --list-models glm-5.3-flash-local` to see its current
capacity, then select it with `/model` or run
`pioneer --model pioneer/glm-5.3-flash-local`.

The model uses the window reported by Alpha and reserves room for output.
Explicit compaction settings still apply. Set the
`pioneer/glm-5.3-flash-local` model override's `maxContextTokens` to `0` if
you want to use the full window with a smaller global cap.

See [the 1.1.1 release notes](https://github.com/coinmastersguild/pi-mono/blob/pioneer-v1.1.1/docs/pioneer-release-1.1.1.md)
for the dialogue and workspace features carried forward in this release.
