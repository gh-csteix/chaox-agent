# Recipe: Meal Photo + Price Note -> SX Expense + BX Food Log

This iOS Shortcut turns a single lunchtime capture (a photo of your meal + a brief voice/text note such as `"Meituan salad 39.9"` / `"美团轻食 39.9"`) into two structured entries running silently in the background:

1. **SX (`RecordSXExpenseIntent`)** — records the expense under an existing project (e.g., `日常餐饮`), reusing existing tags and freezing that day's exchange rate.
2. **BX (`RecordBXFoodIntent`)** — records the meal name, meal slot, and estimated kilocalories (and syncs dietary energy to Apple Health if connected).

No CHAOX server or external computer is required.

---

## Prerequisites

- **SX** and **BX** installed on your iPhone.
- At least one expense-capable project in SX for daily meals (for example, `日常餐饮` or `Daily Dining`).
- A Vision LLM step inside Apple Shortcuts:
  - iOS 26/27 **Use Model** (Apple Intelligence / ChatGPT extension), **or**
  - **Get Contents of URL** calling your own API endpoint (OpenAI, Anthropic, DeepSeek, Qwen, Doubao, or your personal proxy).

---

## Shortcut Steps

### 1. Capture Photo & Note
1. **Receive** Photos from Share Sheet (or if none, **Take Photo** / **Select Photos**).
2. **Ask for Input** (Prompt: `Price & note (e.g. Meituan salad 39.9)`), stored as variable `UserNote`.

### 2. Fetch SX Catalog (`GetSXCatalogIntent`)
3. Add action **SX -> Get Agent Catalog** (`GetSXCatalogIntent`).
   - This returns JSON listing your real `defaultCurrency`, active `projects` (with their `recentExpenseTags`), and existing `tags` (with zero credentials or passwords). Store as `SXCatalogJSON`.

### 3. Parse Photo + Note via Your Vision LLM
4. Resize the photo (e.g., max width `1024px`) if using a cloud API.
5. Call your Vision LLM with the photo, `UserNote`, `Current Date` (ISO 8601), and `SXCatalogJSON`, using this system prompt:

```text
You convert a meal photo and a short user note into a single strict JSON object for two personal apps:
1) SX (project-based expense ledger)
2) BX (daily food calorie log)

Rules:
- Return ONLY valid JSON with keys "sx" and "bx". No markdown fences, no commentary.
- For "sx":
  - Pick an existing project from the provided SX catalog that supports expenses (prefer a daily dining / general spending project; NEVER invent a one-off project name for a single meal).
  - "amount": number > 0 from the user note.
  - "currency": 3-letter ISO currency code (default to the catalog defaultCurrency if omitted).
  - "tags": comma-separated existing tag names from the catalog where applicable (keep existing names, e.g. "午餐,轻食"), or omit/null to let SX inherit the project's latest tags.
  - "notes": concise dish summary in the user's language (no calories here unless useful).
- For "bx":
  - "meal": one of "breakfast", "lunch", "dinner", "snack" based on the current hour or dish.
  - "name": concise dish description in the user's language.
  - "kilocalories": positive integer estimate from the photo.

Expected JSON shape:
{
  "sx": {
    "project": "日常餐饮",
    "amount": 39.9,
    "currency": "CNY",
    "tags": "午餐,轻食",
    "notes": "美团轻食：鸡胸肉藜麦沙拉"
  },
  "bx": {
    "meal": "lunch",
    "name": "美团轻食（鸡胸肉藜麦沙拉 + 溏心蛋）",
    "kilocalories": 460
  }
}
```

6. Parse the model response with **Get Dictionary from Input** (`Parsed`).

### 4. Generate One Shared Idempotency Key
7. Combine `Current Date (yyyyMMdd-HHmmss)` + a random 6-character string (or `UUID`) into variable `IdemKey`.
   - Using the same `IdemKey` guarantees that if a Shortcut retry happens, neither SX nor BX creates a duplicate record.

### 5. Write to SX and BX in Parallel / Sequence
8. Add action **SX -> Record Expense** (`RecordSXExpenseIntent`):
   - `projectName`: `Parsed.sx.project`
   - `amount`: `Parsed.sx.amount`
   - `currency`: `Parsed.sx.currency`
   - `paidAt`: `Current Date`
   - `tags`: `Parsed.sx.tags`
   - `notes`: `Parsed.sx.notes`
   - `idempotencyKey`: `IdemKey`
9. Add action **BX -> Record Food** (`RecordBXFoodIntent`):
   - `name`: `Parsed.bx.name`
   - `kilocalories`: `Parsed.bx.kilocalories`
   - `meal`: `Parsed.bx.meal`
   - `eatenAt`: `Current Date`
   - `idempotencyKey`: `IdemKey`

### 6. Combined Confirmation Notification
10. **Show Notification**:
    - Title: `Saved to SX & BX`
    - Body: `SX: [Parsed.sx.project] [Parsed.sx.amount] [Parsed.sx.currency] · BX: [Parsed.bx.name] ([Parsed.bx.kilocalories] kcal)`

---

## Troubleshooting

- **Project mismatch error from SX**: Ensure the prompt includes `SXCatalogJSON` from step 2 so the LLM picks an exact existing project name. If you have not created a daily food project yet, create one (e.g., `日常餐饮`) in SX first.
- **Duplicate retry safety**: Re-running the same `IdemKey` returns `"status": "deduplicated"` in the JSON receipt and does not create a second entry in SX or BX.
