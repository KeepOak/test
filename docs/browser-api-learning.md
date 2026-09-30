# Learn an API from a browser action

In a browser you control, choose **Learn an API**, enter the website origin, exact API path and GET or POST method, then start observing. Perform the action in that tab and choose **Review API capture**. Observation ends after 30 seconds or 20 requests; the engine permits at most 120 seconds. Closing the tab or losing browser control stops observation.

Branch records request shapes: the selected address and ordinary query/body field names. It does not record header values, cookies, request values or response bodies. Sensitive fields, duplicate query parameters, multipart/form bodies, nested JSON, and non-string JSON values cannot be turned into skills. Captured website data never supplies instructions or executable code.

Select a request, name the skill, and select response fields using dotted paths. Each query field becomes a `q_` input; each body field becomes a `b_` input. Supply inputs afresh and state the expected response values for a real test. POST tests require confirmation of the exact draft and inputs because they may change the website. Tests obey current host rules, network policy, emergency stop, workspace trust and owner authority, and use the same HTTP executor as installed skills. Draft changes invalidate test evidence.

If the API requires authentication, choose an API secret already saved in the active project's locker. Only its name is saved in the skill. Browser sign-in cookies and CSRF tokens are never copied, so browser-session-only APIs may not be reusable this way. Supported credential headers are Authorization and X-Api-Key.

A successful test records the draft and test fingerprints, without keeping supplied test values or returned values. Choose **Install tested skill** to install through the normal skill package validator. It arrives switched off. Enable it in Skills to let future tasks call `skill.<name>.call` without opening a browser. This proves the selected request and expected values; it does not establish that every possible input will work.

The owner-window endpoint is `POST /api/panels/browser/network`. Every request is bound to the live conversation, browser control, epoch, owner client and selected tab. Phone/door access and short-lived keys cannot start capture, test, or install through it.
