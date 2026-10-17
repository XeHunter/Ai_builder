"""Import every model so ``Base.metadata`` is complete (Alembic autogenerate, create_all in tests)."""

from app.db.models.analytics import (
    AffinityRule,
    AffinityRun,
    CategoryAffinity,
    ForecastProductSummary,
    ForecastResult,
    ForecastRun,
    MerchandisingRecommendation,
)
from app.db.models.catalog import Product, ProductCategory, ProductEmbedding, ProductImage, ProductRelation
from app.db.models.fraud import FraudAlert, FraudInvestigation, FraudLabel, FraudRule, InvestigationNote
from app.db.models.identity import (
    AuthSession,
    Merchant,
    MerchantMembership,
    MerchantSettings,
    Permission,
    Role,
    StoreMembership,
    User,
    role_permissions,
)
from app.db.models.inventory import (
    ExpiryAlert,
    ImportJob,
    ImportJobRow,
    InventoryBatch,
    InventoryItem,
    StockAdjustment,
    StoreTask,
)
from app.db.models.ops import (
    AuditEvent,
    GeofenceEvent,
    IntegrationConfig,
    JobRun,
    Notification,
    NotificationPreference,
)
from app.db.models.pricing import (
    Coupon,
    CouponRedemption,
    PriceChange,
    PriceChangeEvent,
    PricingRule,
    Promotion,
    PromotionProduct,
)
from app.db.models.sales import AccountSecurityEvent, SalesTransaction, TransactionItem, WeatherRecord
from app.db.models.shopping import (
    ListInvitation,
    ListMembership,
    ShoppingList,
    ShoppingListEvent,
    ShoppingListItem,
)
from app.db.models.store import (
    LayoutFixture,
    NavEdge,
    NavNode,
    ProductPlacement,
    ShelfLocation,
    Store,
    StoreLayout,
)

__all__ = [
    "AccountSecurityEvent", "AffinityRule", "AffinityRun", "AuditEvent", "AuthSession", "CategoryAffinity",
    "Coupon", "CouponRedemption", "ExpiryAlert", "ForecastProductSummary", "ForecastResult", "ForecastRun",
    "FraudAlert", "FraudInvestigation", "FraudLabel", "FraudRule", "GeofenceEvent", "ImportJob", "ImportJobRow",
    "IntegrationConfig", "InventoryBatch", "InventoryItem", "InvestigationNote", "JobRun", "LayoutFixture",
    "ListInvitation", "ListMembership", "MerchandisingRecommendation", "Merchant", "MerchantMembership",
    "MerchantSettings", "NavEdge", "NavNode", "Notification", "NotificationPreference", "Permission",
    "PriceChange", "PriceChangeEvent", "PricingRule", "Product", "ProductCategory", "ProductEmbedding",
    "ProductImage", "ProductPlacement", "ProductRelation", "Promotion", "PromotionProduct", "Role",
    "SalesTransaction", "ShelfLocation", "ShoppingList", "ShoppingListEvent", "ShoppingListItem",
    "StockAdjustment", "Store", "StoreLayout", "StoreMembership", "StoreTask", "TransactionItem", "User",
    "WeatherRecord", "role_permissions",
]
