# Connect a model

## What this is for

Branch Agent does not think by itself. It borrows the thinking from a model service you choose — the
company that runs the model, or a program running on this very computer. This chapter is about
choosing one, paying as little as you have to, and knowing what each choice costs.

## In one minute

- **Settings → ChatGPT account** uses a ChatGPT plan you already pay for.
- **Settings → Models** adds a connection to any of 38 services with a key.
- **Settings → Models on this computer** runs a model here instead, free and private.
- **Settings → Which model does what** says which connection answers which kind of work.
- **Usage** shows what everything has cost, in real money, all worked out on this computer.

## The three ways in

**A ChatGPT plan.** **Settings → ChatGPT account** signs you in on OpenAI's own website with a short
code. Branch never sees your password. Signing in registers a few presets and makes ChatGPT the
default if no other model was chosen yet. Access through a plan is something OpenAI
provides for its own tools and may change without notice.

**A key from a service.** **Settings → Models** lets you pick a service, paste its key, and fill in
anything else it needs. Branch checks the key by using it *before* anything is saved, then puts the
key in the locker (see [Permissions and safety](04-permissions-and-safety.md)) and answers with the
models it found. The key never appears in the answer, in an error message, or in any log.

**A model on this computer.** **Settings → Models on this computer** works with Ollama and LM Studio.
Nothing leaves the machine and nothing is charged. See *Models that run here* below.

## Which services work

Branch knows 38 model services, kept as plain data rather than as code, so the list in Settings, the
table in the reference and the setup screen can never disagree. Among them: OpenAI, Azure OpenAI,
Anthropic, Google Gemini, Google Vertex AI, AWS Bedrock, Mistral, Groq, OpenRouter, Together,
Fireworks, DeepSeek, xAI, Perplexity, Cohere, Cerebras, SambaNova, Hugging Face, GitHub Models,
Cloudflare, Ollama, LM Studio, vLLM and llama.cpp. Most want nothing but a key. A few want one or two
extra boxes filled in — a region, a project id, a deployment name — and the screen asks for exactly
those.

Every one of them has been tested against a stand-in of the service rather than against the real
thing. Treat that as *"Branch speaks the right language"*, not as *"this was tried on a live account"*.

**Settings → Check your connections** asks each connection what it can actually do right now: whether
its key still works, how many models it lists, and whether it offers speech, pictures and comparing
passages. It costs nothing beyond one small request per connection.

## Choosing what answers

Above the message box, the rail always names the model that will answer next. Type `/model` there to
see your connections and `/model <name>` to change the one answering **this conversation only** —
no restart, nothing else affected. `/model default` puts it back.

**Settings → Models** chooses the workspace default, the default thinking effort (low, medium or
high), the order Branch falls back through when a connection fails, and how long a failed connection
rests before it is tried again. Every task records which connection actually answered.

**Settings → Which model does what** holds *routing profiles* — a name and an order of connections.
Branch fills in four from the connections you really have: **Cheap and fast**, **Best quality**,
**Private** (only connections on this computer, honestly empty until you set one up) and **Long
context** (your own order). None is switched on until you pick one. When a profile picks, the task
records a plain sentence saying why that connection answered.

## Several accounts for one service

**Settings → Accounts** (off until you switch it on) lets one connection hold several API
keys or sign-ins, each with a name; `/account` lists them and `/account <name>` switches the
conversation. API keys move on to the next key by themselves when one is rate limited.

Sign-ins are different. **Branch never moves your work between your own plans of one service** — two
ChatGPT plans or two Claude plans that are both yours — to get past a limit: providers treat that as
abuse and may suspend the accounts. When your plan runs out, the task stops and says so. *Share work
between these accounts* can move work only between one of your own plans and an account you marked
**kept separate**: one that really belongs to someone else or to work, such as your work plan or a
family member's own plan. Tick *Kept separate* on that account, or type `/account separate <name>`
(`/account not-separate <name>` takes the mark off). Nothing is ever marked for you. If a list of
yours used to share work between your own plans, Branch stopped it and says why once, on the card.

## Models that run here

**Settings → Models on this computer** sees, starts, downloads and removes models in Ollama and LM
Studio. It reads this computer's memory, processor cores and graphics card, and offers three sizes
with a plain reason for each: small (about 2 GB, fast, good for notes), medium (about 5 GB, a steady
all-rounder) and large (about 9 GB, slower but better at reasoning), each marked as fitting this
computer or not. A download runs in the background with a progress bar.

Routing rules on the same screen can send a task that mentions personal details to the local model,
send long or tool-heavy work to the cloud, or use the free local model whenever a cloud one would
cost more than a ceiling you set. What you explicitly choose for a conversation always wins.

**What is only partly there:** the routing rule includes a *"the local server is not answering, use
the cloud one"* branch, but nothing checks the local server before a task starts, so a task sent to a
local model that does not answer falls back the ordinary way, through the connection's fallback order.

## What it costs

Branch keeps a table of published list prices per million words of context for the common models of
each service, with the date it was last checked. **Usage** shows what your tasks have cost, worked
out on this computer from your own tasks — nothing is sent anywhere to produce those figures.

**A model with no price on file is never shown as costing nothing.** It reads *"no price on file"*
everywhere it appears. A model running on this computer is priced at zero on purpose, which is a
different thing. Correct or add a price under **Usage → Model prices**.

These are estimates for your own planning from published list prices. They are not a bill, they know
nothing about your discounts or free tiers, and they go stale when a service changes its prices.

**Usage → Monthly limit** stops new tasks starting once the month reaches a number of words, an
amount of money, or either. Leave a box empty to not use it.

## When a service has a bad day

Branch retries a failed request at most twice per round, waiting a quarter of a second then half a
second, and honouring any wait the service asks for. Only genuinely temporary failures qualify — a
wrong key, a refused permission and an exhausted spending allowance are not retried, because trying
again would not help. Completed tool work is never repeated. When a connection keeps failing, Branch
rests it and moves on to the next one in your fallback order, and says which one answered and why.

## Two things Branch will not do here

- **One assistant, not several.** There is no setting to pick a different assistant engine inside the
  app. When work genuinely belongs to a different assistant, Branch hands it over — see
  [For builders](07-for-builders.md).
- **No Google PaLM.** Google retired it in favour of Gemini. Use the Gemini entry for a Google AI
  Studio key, or Vertex AI for a Google Cloud project.

## Where to go next

- [Everyday tasks](02-everyday-tasks.md) — now that something can answer you.
- [Permissions and safety](04-permissions-and-safety.md) — where your key is kept, and how.
