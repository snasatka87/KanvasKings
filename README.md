# Kanvas Kings

An offline-friendly door-to-door outreach tracker. Log an address, contact name, outcome, and notes; see symbol-coded pins on a satellite map; review totals; search history; and export results as CSV. Outcomes include No Answer, Qualified Lead, Sale, Completed Job, Retail Roof Complete, Not Interested, Do Not Disturb, New Roof, and Approved Roof.

## Run locally

Serve this folder over HTTP so the service worker and installable app features work:

```sh
python3 -m http.server 4173
```

Then open `http://localhost:4173` in your browser. The map and address lookup need an internet connection. Before enabling company accounts, configure Supabase as described below.

## Publish the app at www.KanvasKings.com

The repository is configured to deploy the static app to GitHub Pages whenever changes are pushed to `main`. The workflow and custom domain are prepared, but a repository owner must enable Pages and configure DNS once:

1. In the repository on GitHub, open **Settings → Pages**. Under **Build and deployment**, choose **GitHub Actions** as the source.
2. At your domain registrar/DNS provider, create a `CNAME` record for host `www` pointing to `snasatka87.github.io`. Remove any conflicting `www` records. If you also want the bare `kanvaskings.com` address to work, configure it to redirect to `https://www.kanvaskings.com` or set up the registrar's recommended GitHub Pages apex records.
3. In **Settings → Pages → Custom domain**, enter `www.kanvaskings.com` and save. Enable **Enforce HTTPS** once GitHub finishes checking the domain. Only set this up for a domain you own or are authorized to configure.
4. Push the repository's `main` branch to GitHub. The **Actions** tab will show the deploy workflow; after it succeeds, the app will be available at `https://www.kanvaskings.com`.
5. To enable accounts and shared company logs on the published domain, follow the Supabase setup below and set the Supabase production Site URL and redirect allow-list to `https://www.kanvaskings.com`.

GitHub Pages and DNS cannot be activated from this workspace because GitHub is not authenticated here and DNS settings require access to the domain registrar. The domain must also be registered before the DNS record can be added.

## Company accounts and shared daily logs

The company access page uses Supabase Auth. Team members create their own account, then join the same workspace by entering the company's exact name and private join code. Company daily logs are stored in Supabase and shared live with workspace members. Row-level security prevents users outside a company from reading or changing its logs. Pin photos and custom logos remain local to each browser.

1. Create a Supabase project at [supabase.com](https://supabase.com/). In the project dashboard, open **Project Settings → API** (or **API Keys**) and copy the **Project URL** and the public **anon/publishable key**. The URL looks like `https://your-project-ref.supabase.co`. Never put a `service_role` or secret key in this app.
2. In the Supabase **SQL Editor**, run [`supabase-schema.sql`](./supabase-schema.sql) to create the company tables, join-code checks, access policies, and live-update publication.
3. In **Authentication → URL Configuration**, set the production Site URL to `https://www.kanvaskings.com` after the domain is live, and add `https://www.kanvaskings.com/**` and (if needed for local testing) `http://localhost:4173/**` to the allowed redirect URLs.
4. Put the Project URL and public key in [`supabase-config.js`](./supabase-config.js), in the `url` and `anonKey` fields. This key is public by design; access is protected by authentication and database row-level security.
5. The company owner registers, selects **I’m the owner creating a new workspace**, enters the company name, and chooses a private join code of at least 16 characters. The owner shares the exact company name and join code with coworkers through a private channel. Coworkers register or log in, select **Join existing company**, and enter both values. Names are case-sensitive; do not share the join code publicly.

With Supabase configured, the tracker requires a company login and uses the selected company workspace instead of the browser's legacy local-only door list. Existing local-only records are not automatically uploaded; export them before switching workspaces if you need to preserve them. You can leave the URL/key blank for the original local-only mode, but company registration and cross-device sharing will not be available until a Supabase project is configured.

## Data and map services

- Satellite imagery uses Esri World Imagery, with CARTO as a tile fallback. Address lookup and map reverse-geocoding use Nominatim; requests are spaced to respect its public service usage policy.
- Nearby hail history uses NOAA/SPC storm reports and summarizes the largest reported hail size for each report date within 25 miles. Current-year records come from the daily SPC reports archive; prior years use the annual archive. Pin summaries include distance and compass direction to the nearest point on a reported hail path; report locations are approximate observations, not verified property-level hail measurements.
- Search for or zoom to an area such as Palmerton before selecting a hail date. The map then shows all SPC reports within 250 miles of that area and zooms to their regional extent; without a focused area or geocoded pins, it shows the largest report cluster while retaining the full-day overlay. Older dates can fall back to the annual SPC archive. Use the **Percentage** and **Size** map buttons to switch the persistent shaded overlay: Percentage shows an uncalibrated proximity estimate, with areas below 10% transparent; Size colors the largest reported hail within 5 miles (blue for 0.50–<0.75 in, yellow for 0.75–<1.25 in, orange for 1.25–<1.75 in, red for 1.75–<2.50 in, and purple for 2.50+ in). In Size mode shades darken as reported size increases within each band; opacity fades with distance from a report/path and becomes transparent at 5 miles. Clicking the map places a marker labeled with the proximity estimate; size-threshold estimates are listed separately and are not meteorological probabilities. SPC reports cannot provide Verisk's radar-derived hail footprints; report locations and shaded areas are approximate, not verified hail footprints or confirmation at a specific property. Use **Clear hail map** to remove the overlay.
- Pin photos are saved locally in this browser using IndexedDB; each pin supports up to 8 JPEG, PNG, WebP, or GIF images, up to 8 MB each.
- A service worker caches the app shell, map library, and previously viewed map tiles for limited offline use.
- Use the location button on the map to start or stop live tracking. Location access requires browser permission and HTTPS or localhost.
- Clearing browser site data removes locally saved door records and photos. Export your CSV before clearing data or switching devices; CSV exports do not contain photos.
