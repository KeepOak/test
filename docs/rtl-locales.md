# Arabic and RTL

Arabic (`ar`) is a bundled **partial translation draft**, explicitly labelled in Setup, Appearance and profile language choices. The translated subset covers common actions, core navigation/search, composer controls, Home panel, setup safety text, and selected Appearance/settings labels. Other keys use the existing English fallback; this is not full Arabic coverage or a reviewed translation.

The existing locale startup/document-direction foundation from #937 is carried forward. An Arabic preference such as `ar-SA` resolves to `ar`; a saved language wins. Selecting Arabic sets `lang=ar` and `dir=rtl`, and selecting an LTR locale restores `dir=ltr`. The engine’s look schema accepts `ar`, so Setup/Appearance/profile language saves use the real existing route. Dates/numbers continue to use the existing Intl formatting. No dependencies or external font downloads are added.

RTL layout rules mirror the sidebar, panel and Home edges, merged titlebar and Settings navigation at the existing breakpoints, with logical borders/margins/insets and start-aligned labels. Resizer pointer and arrow deltas follow inline direction. Chat content uses plaintext bidi resolution; code, keycaps, URL and email fields are isolated LTR. Native OS titlebar buttons, third-party charts/canvases, specialist pages, custom dropdown placement and rich mixed-direction output still need an actual rendered accessibility/layout walk.

Validation in this session was source review and diff checks only. No browser, app runtime, tests, builds, providers or models were executed. Remaining translations and layout verification are explicit gaps.
