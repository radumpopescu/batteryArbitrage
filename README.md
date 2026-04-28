# Romania Battery Arbitrage Simulator

A small local simulator for charging a battery during cheap Romanian PZU / OPCOM day-ahead price intervals and discharging when prices are higher.

## Run

```bash
node server.js
```

Then open `http://localhost:4173`.

## Docker

```bash
docker compose up --build
```

The app is served on `http://localhost:4173`. Downloaded OPCOM CSV files are saved to `./data` next to `compose.yml`.

## Data

The app downloads OPCOM public PZU CSV exports:

```text
https://www.opcom.ro/rapoarte-pzu-raportPIP-export-csv/DD/MM/YYYY/en
```

The source currently returns Romania Market Clearing Price data in EUR/MWh. Older files may be hourly while newer files may be 15-minute; the model reads the CSV resolution per row and supports requests up to 366 days.

When running locally without Docker, downloaded OPCOM CSV files are cached in:

```text
data/opcom-pzu/
```

The UI shows how many delivery days are stored, the downloaded date ranges, and whether the current simulation used cached files or downloaded new ones.

## Model Notes

The simulator estimates gross wholesale arbitrage value only. It does not include network tariffs, VAT, supplier margins, imbalance exposure, OPCOM participation/licensing constraints, battery degradation, taxes, financing, or metering limitations.
