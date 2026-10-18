from fastapi import APIRouter

from app.api.v1 import (
    analytics,
    auth,
    channels,
    cross_selling,
    demo,
    expiry,
    forecasting,
    fraud,
    inventory,
    merchandising,
    notifications,
    onboarding,
    pricing,
    products,
    promotions,
    realtime,
    shared_shopping,
    shopping_assistant,
    shopping_lists,
    store_navigation,
)

api_router = APIRouter(prefix="/api/v1")
for module in (auth, products, shopping_assistant, shopping_lists, shared_shopping, store_navigation, inventory, expiry,
               forecasting, pricing, promotions, merchandising, cross_selling, fraud, analytics, notifications, onboarding, channels, realtime, demo):
    api_router.include_router(module.router)
