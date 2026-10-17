# Development notes

## Demo walkthrough (what to click)

### Shopper (`priya@demo.omnipulse.ai` / `Demo@12345`)
1. Store picker (top right): *FreshMart Andheri West*.
2. **Lists → New smart list**: paste `Milk, eggs, bread, chocolate, diapers, detergent, and coffee.`
   → review matches (milk has several candidates; change one if you like) → create.
3. On the list: **Plan route** → see the numbered stops on the map and turn-by-turn steps; click the
   floor to change the start point; tick items as you collect them.
4. **Share**: create an invitation; open the link as `rohan@demo.omnipulse.ai` in another browser
   profile → tick an item and watch it update live in the first window.
5. **Photo search**: upload `data/sample/query_images/photo_sea-001.jpg` (an umbrella photo).
6. **Assistant**: open the Canon camera product page → *Ask the assistant* → "Which compatible
   memory card goes with this camera?".
7. **Offers**: enable location consent and marketing, then "Near FreshMart Andheri West" in the
   location simulator → a proximity coupon is issued and a notification appears.

### Merchant (`admin@freshmart.demo` / `Demo@12345`)
1. **Overview**: KPIs, trends and alerts (all computed from the database; data is demo data).
2. **Inventory → Import**: upload `data/sample/inventory_import_sample.csv` → inspect the 7 rows
   with errors and the warnings → commit the 6 valid rows → review the summary.
3. **Expiry**: the 40 cartons of full-cream milk (batch `MLK-002-B1`) expire within 48 h; open the
   linked price change (20% markdown + clearance instruction).
4. **Pricing → Price changes**: approve & publish the milk markdown (simulated shelf-label
   publisher) → staff tasks appear under Expiry → Store tasks.
5. **Forecasting**: open the latest run; drill into *Folding Umbrella* to see rain-associated demand.
6. **Cross-selling**: rules (camera ↔ memory card), category heatmap and product network.
7. **Store layout**: create a draft, drag a product onto an endcap, compare with active, publish.
8. **Merchandising**: review the safety relocation (5 kg atta at 140 cm) and adjacency tests;
   apply one to the draft layout.
9. **Fraud**: open the duplicate-receipt alert, add a note and close it with an outcome; check the
   evaluation tab.
10. **Settings & audit**: see the audit events produced by the steps above.

## Useful commands
```bash
python -m app.cli check            # config summary
python -m app.cli run-jobs         # drain queued jobs once
python -m app.docs_gen             # regenerate docs/api and the ER diagram
pytest -k shopping -q              # subset of tests
```
