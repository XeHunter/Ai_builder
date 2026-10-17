from fastapi import APIRouter

from app.api.v1 import (
    analytics,
    auth,
    cross_selling,
    expiry,
    forecasting,
    fraud,
    inventory,
    merchandising,
    notifications,
    pricing,
    products,
    promotions,
    shared_shopping,
    shopping_assistant,
    shopping_lists,
    store_navigation,
)

api_router = APIRouter(prefix="/api/v1")
for module in (auth, products, shopping_assistant, shopping_lists, shared_shopping, store_navigation, inventory, expiry,
               forecasting, pricing, promotions, merchandising, cross_selling, fraud, analytics, notifications):
    api_router.include_router(module.router)
