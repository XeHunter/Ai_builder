"""Permission codes and built-in merchant roles (seeded into roles/permissions tables)."""

PERMISSIONS: dict[str, str] = {
    "catalog.read": "View products and categories",
    "catalog.write": "Create and edit products",
    "inventory.read": "View stock, batches and adjustments",
    "inventory.write": "Adjust stock and edit batches",
    "inventory.import": "Import inventory files",
    "expiry.manage": "Manage expiry alerts and markdown recommendations",
    "forecast.read": "View demand forecasts",
    "forecast.run": "Run demand forecasts",
    "pricing.read": "View price changes, rules and promotions",
    "pricing.recommend": "Create price recommendations and promotion drafts",
    "pricing.approve": "Approve or reject price changes and promotions",
    "pricing.publish": "Publish approved price changes",
    "layout.read": "View store layouts",
    "layout.write": "Edit store layouts and planograms",
    "merchandising.read": "View merchandising recommendations",
    "merchandising.manage": "Review and act on merchandising recommendations",
    "affinity.read": "View product-affinity analytics",
    "affinity.run": "Run product-affinity analysis",
    "fraud.read": "View fraud alerts",
    "fraud.investigate": "Investigate and close fraud alerts",
    "insights.read": "View dashboards and customer shopping insights",
    "integrations.manage": "Configure integrations",
    "settings.manage": "Manage merchant settings and policies",
    "audit.read": "View audit logs",
}

_READ = {p for p in PERMISSIONS if p.endswith(".read")}

ROLES: dict[str, tuple[str, set[str]]] = {
    "merchant_admin": ("Full control of the merchant account", set(PERMISSIONS)),
    "store_manager": (
        "Runs day-to-day operations for assigned stores",
        set(PERMISSIONS) - {"integrations.manage", "settings.manage"},
    ),
    "analyst": (
        "Read-only analytics access plus running analyses",
        _READ | {"forecast.run", "affinity.run"},
    ),
}
