"""Demo catalog: categories, products, shelf placements and shopping-mission definitions.

Prices are in INR and indicative only. All data here is synthetic demo data.
"""

from __future__ import annotations

# slug: (name, is_perishable, requires_chilling)
CATEGORIES = {
    "dairy": ("Dairy", True, True),
    "eggs": ("Eggs", True, False),
    "bakery": ("Bakery", True, False),
    "produce": ("Fruits & Vegetables", True, False),
    "breakfast": ("Breakfast & Spreads", False, False),
    "tea-coffee": ("Tea & Coffee", False, False),
    "snacks": ("Snacks & Confectionery", False, False),
    "beverages": ("Beverages", False, False),
    "staples": ("Staples", False, False),
    "personal-care": ("Personal Care", False, False),
    "household": ("Household & Cleaning", False, False),
    "baby": ("Baby Care", False, False),
    "electronics": ("Electronics & Accessories", False, False),
    "seasonal": ("Seasonal", False, False),
    "frozen": ("Frozen", True, True),
    "gift-cards": ("Gift Cards", False, False),
}

# (sku, name, category, brand, unit, price, cost, min_price, shelf_life_days|None, weight_kg, tags, description, shelf)
PRODUCTS: list[tuple] = [
    ("MLK-001", "Amul Taaza Toned Milk 1 L", "dairy", "Amul", "1 L", 68, 50, 52, 3, 1.0, ["milk", "dairy"], "Toned milk, 1 litre pouch.", "D-2-2"),
    ("MLK-002", "Amul Gold Full Cream Milk 1 L", "dairy", "Amul", "1 L", 72, 54, 56, 3, 1.0, ["milk", "dairy", "full cream"], "Full cream milk, 1 litre.", "D-2-3"),
    ("MLK-003", "Mother Dairy Cow Milk 500 ml", "dairy", "Mother Dairy", "500 ml", 32, 24, 25, 3, 0.5, ["milk", "dairy"], "Fresh cow milk, half litre.", "D-3-2"),
    ("DRY-001", "Amul Butter 100 g", "dairy", "Amul", "100 g", 58, 44, 48, 60, 0.1, ["butter", "dairy", "breakfast"], "Pasteurised salted butter.", "D-4-3"),
    ("DRY-002", "Amul Masti Dahi 400 g", "dairy", "Amul", "400 g", 40, 30, 32, 7, 0.4, ["curd", "dahi", "yogurt"], "Set curd.", "D-4-2"),
    ("DRY-003", "Amul Cheese Slices 200 g", "dairy", "Amul", "200 g", 145, 112, 120, 120, 0.2, ["cheese", "dairy"], "Processed cheese slices, 10 pieces.", "D-5-3"),
    ("DRY-004", "Fresh Malai Paneer 200 g", "dairy", "FreshMart", "200 g", 95, 70, 72, 5, 0.2, ["paneer", "dairy"], "Soft cottage cheese.", "D-5-2"),
    ("EGG-001", "Farm Fresh White Eggs (12 pack)", "eggs", "FreshMart", "12 pc", 96, 74, 78, 14, 0.7, ["eggs", "breakfast"], "A dozen farm-fresh eggs.", "D-6-2"),
    ("EGG-002", "Country Brown Eggs (6 pack)", "eggs", "FreshMart", "6 pc", 66, 50, 54, 14, 0.4, ["eggs", "breakfast"], "Six brown eggs.", "D-6-3"),
    ("BRD-001", "Harvest Gold White Bread 400 g", "bakery", "Harvest Gold", "400 g", 45, 34, 35, 4, 0.4, ["bread", "breakfast"], "Soft white sandwich bread.", "P-3-2"),
    ("BRD-002", "Harvest Gold Brown Bread 400 g", "bakery", "Harvest Gold", "400 g", 55, 41, 43, 4, 0.4, ["bread", "breakfast", "brown"], "Whole-wheat brown bread.", "P-3-3"),
    ("BRD-003", "Multigrain Bread 450 g", "bakery", "The Baker's Dozen", "450 g", 65, 48, 50, 4, 0.45, ["bread", "breakfast", "multigrain"], "Multigrain loaf.", "P-2-3"),
    ("BKY-001", "Burger Buns (4 pc)", "bakery", "FreshMart Bakery", "4 pc", 40, 28, 30, 3, 0.3, ["buns", "bakery"], "Sesame burger buns.", "P-2-2"),
    ("BKY-002", "Butter Croissant (2 pc)", "bakery", "FreshMart Bakery", "2 pc", 90, 60, 65, 2, 0.2, ["croissant", "bakery", "breakfast"], "Freshly baked croissants.", "P-2-1"),
    ("FRU-001", "Robusta Bananas (dozen)", "produce", None, "12 pc", 60, 40, 42, 5, 1.2, ["bananas", "fruit", "breakfast"], "Ripe bananas.", "P-1-2"),
    ("FRU-002", "Shimla Apples 1 kg", "produce", None, "1 kg", 180, 135, 140, 14, 1.0, ["apples", "fruit"], "Crisp red apples.", "P-1-3"),
    ("VEG-001", "Tomatoes 1 kg", "produce", None, "1 kg", 40, 26, 28, 6, 1.0, ["tomatoes", "vegetables"], "Farm tomatoes.", "P-1-1"),
    ("VEG-002", "Onions 1 kg", "produce", None, "1 kg", 35, 24, 25, 20, 1.0, ["onions", "vegetables"], "Red onions.", "P-1-1"),
    ("CER-001", "Kellogg's Corn Flakes 475 g", "breakfast", "Kellogg's", "475 g", 195, 150, 160, None, 0.5, ["cereal", "cornflakes", "breakfast"], "Classic corn flakes.", "A1-L-1-3"),
    ("CER-002", "Saffola Masala Oats 500 g", "breakfast", "Saffola", "500 g", 185, 140, 150, None, 0.5, ["oats", "cereal", "breakfast"], "Savoury masala oats.", "A1-L-1-4"),
    ("CER-003", "Fruit & Nut Muesli 500 g", "breakfast", "Yoga Bar", "500 g", 325, 240, 260, None, 0.5, ["muesli", "cereal", "breakfast"], "Muesli with fruit and nuts.", "A1-L-2-3"),
    ("SPR-001", "Kissan Mixed Fruit Jam 500 g", "breakfast", "Kissan", "500 g", 165, 122, 130, None, 0.5, ["jam", "spread", "breakfast"], "Mixed fruit jam.", "A1-L-2-2"),
    ("SPR-002", "Crunchy Peanut Butter 340 g", "breakfast", "Pintola", "340 g", 199, 145, 155, None, 0.35, ["peanut butter", "spread", "breakfast"], "Crunchy peanut butter.", "A1-L-2-4"),
    ("HNY-001", "Dabur Honey 500 g", "breakfast", "Dabur", "500 g", 235, 175, 185, None, 0.5, ["honey", "breakfast"], "Pure honey.", "A1-L-3-3"),
    ("COF-001", "Nescafe Classic Instant Coffee 100 g", "tea-coffee", "Nescafe", "100 g", 345, 270, 280, None, 0.1, ["coffee", "instant coffee", "hot beverage"], "Instant coffee jar.", "A1-R-1-3"),
    ("COF-002", "Bru Instant Coffee 100 g", "tea-coffee", "Bru", "100 g", 290, 225, 235, None, 0.1, ["coffee", "instant coffee", "hot beverage"], "Instant coffee-chicory blend.", "A1-R-1-4"),
    ("COF-003", "South Indian Filter Coffee 500 g", "tea-coffee", "Cothas", "500 g", 420, 320, 340, None, 0.5, ["coffee", "filter coffee", "hot beverage"], "Filter coffee powder.", "A1-R-2-3"),
    ("TEA-001", "Tata Tea Premium 500 g", "tea-coffee", "Tata Tea", "500 g", 290, 230, 250, None, 0.5, ["tea", "chai", "hot beverage", "rain"], "Strong blended tea leaves.", "A1-R-3-3"),
    ("TEA-002", "Taj Mahal Tea 250 g", "tea-coffee", "Brooke Bond", "250 g", 180, 140, 150, None, 0.25, ["tea", "chai", "hot beverage"], "Premium tea leaves.", "A1-R-3-4"),
    ("TEA-003", "Organic Green Tea (25 bags)", "tea-coffee", "Organic India", "25 bags", 160, 115, 125, None, 0.05, ["green tea", "tea", "hot beverage"], "Green tea bags.", "A1-R-4-3"),
    ("BEV-003", "Hot Chocolate Mix 200 g", "tea-coffee", "Cadbury", "200 g", 245, 180, 190, None, 0.2, ["hot chocolate", "hot beverage", "rain"], "Drinking chocolate powder.", "A1-R-4-4"),
    ("BEV-004", "Bournvita 500 g", "tea-coffee", "Cadbury", "500 g", 235, 180, 190, None, 0.5, ["malt drink", "hot beverage"], "Chocolate malt drink.", "A1-R-2-4"),
    ("CHO-001", "Cadbury Dairy Milk Silk Chocolate 60 g", "snacks", "Cadbury", "60 g", 90, 66, 70, None, 0.06, ["chocolate", "confectionery"], "Silky milk chocolate bar.", "A2-L-1-3"),
    ("CHO-002", "Cadbury Dairy Milk Chocolate 24 g", "snacks", "Cadbury", "24 g", 20, 14, 15, None, 0.03, ["chocolate", "confectionery"], "Milk chocolate bar.", "A2-L-1-4"),
    ("CHO-003", "KitKat 4 Finger Chocolate Wafer", "snacks", "Nestle", "37 g", 30, 21, 23, None, 0.04, ["chocolate", "wafer", "confectionery"], "Chocolate-coated wafer.", "A2-L-2-3"),
    ("CHO-004", "Dark Chocolate 70% 100 g", "snacks", "Amul", "100 g", 175, 125, 135, None, 0.1, ["chocolate", "dark chocolate"], "70% cocoa dark chocolate.", "A2-L-2-4"),
    ("BIS-001", "Britannia Good Day Cashew Biscuits 200 g", "snacks", "Britannia", "200 g", 40, 30, 32, None, 0.2, ["biscuits", "cookies"], "Cashew cookies.", "A2-L-3-3"),
    ("BIS-002", "Parle-G Biscuits 800 g", "snacks", "Parle", "800 g", 90, 70, 74, None, 0.8, ["biscuits", "glucose"], "Glucose biscuits family pack.", "A2-L-3-1"),
    ("SNK-001", "Lay's Classic Salted Chips 52 g", "snacks", "Lay's", "52 g", 20, 14, 15, None, 0.05, ["chips", "crisps", "snacks"], "Salted potato chips.", "A2-R-1-3"),
    ("SNK-002", "Haldiram's Aloo Bhujia 400 g", "snacks", "Haldiram's", "400 g", 110, 80, 85, None, 0.4, ["namkeen", "snacks"], "Spiced potato noodles.", "A2-R-1-2"),
    ("BEV-001", "Coca-Cola 750 ml", "beverages", "Coca-Cola", "750 ml", 45, 33, 35, None, 0.8, ["cola", "soft drink"], "Carbonated soft drink.", "A2-R-2-2"),
    ("BEV-002", "Bisleri Mineral Water 1 L", "beverages", "Bisleri", "1 L", 20, 13, 14, None, 1.0, ["water"], "Packaged drinking water.", "A2-R-2-1"),
    ("JUC-001", "Real Orange Juice 1 L", "beverages", "Real", "1 L", 125, 92, 98, None, 1.0, ["juice", "orange juice", "breakfast"], "Orange fruit juice.", "A2-R-3-3"),
    ("STP-001", "India Gate Basmati Rice 5 kg", "staples", "India Gate", "5 kg", 699, 560, 590, None, 5.0, ["rice", "basmati"], "Long-grain basmati rice.", "A3-L-1-1"),
    ("STP-002", "Aashirvaad Whole Wheat Atta 5 kg", "staples", "Aashirvaad", "5 kg", 285, 225, 240, None, 5.0, ["atta", "flour"], "Whole wheat flour.", "A3-L-1-4"),
    ("STP-003", "Toor Dal 1 kg", "staples", "Tata Sampann", "1 kg", 165, 128, 135, None, 1.0, ["dal", "pulses"], "Unpolished toor dal.", "A3-L-2-3"),
    ("STP-004", "Fortune Sunflower Oil 1 L", "staples", "Fortune", "1 L", 165, 130, 138, None, 0.9, ["oil", "cooking oil"], "Refined sunflower oil.", "A3-R-1-2"),
    ("STP-005", "Tata Salt 1 kg", "staples", "Tata", "1 kg", 28, 21, 22, None, 1.0, ["salt"], "Iodised salt.", "A3-R-2-3"),
    ("STP-006", "Sugar 1 kg", "staples", "FreshMart", "1 kg", 48, 38, 40, None, 1.0, ["sugar"], "Refined sugar.", "A3-R-2-2"),
    ("PRC-001", "Colgate Strong Teeth Toothpaste 200 g", "personal-care", "Colgate", "200 g", 110, 78, 84, None, 0.2, ["toothpaste", "oral care"], "Cavity-protection toothpaste.", "A4-L-1-3"),
    ("PRC-002", "Sensodyne Sensitive Toothpaste 70 g", "personal-care", "Sensodyne", "70 g", 199, 145, 155, None, 0.07, ["toothpaste", "oral care", "sensitive"], "Toothpaste for sensitive teeth.", "A4-L-1-4"),
    ("PRC-003", "Oral-B Toothbrush Medium", "personal-care", "Oral-B", "1 pc", 60, 38, 42, None, 0.02, ["toothbrush", "oral care"], "Medium-bristle toothbrush.", "A4-L-2-3"),
    ("PRC-004", "Dove Intense Repair Shampoo 340 ml", "personal-care", "Dove", "340 ml", 325, 235, 250, None, 0.35, ["shampoo", "hair care"], "Repairing shampoo.", "A4-R-1-3"),
    ("PRC-005", "Dettol Original Soap (4 x 75 g)", "personal-care", "Dettol", "4 pc", 180, 130, 140, None, 0.3, ["soap", "bath"], "Antibacterial soap pack.", "A4-R-2-3"),
    ("BAB-003", "Baby Wipes (72 pc)", "baby", "Himalaya", "72 pc", 199, 130, 140, None, 0.4, ["baby wipes", "wipes", "baby"], "Gentle baby wipes.", "A4-R-4-3"),
    ("HHD-001", "Surf Excel Matic Detergent Powder 2 kg", "household", "Surf Excel", "2 kg", 475, 370, 390, None, 2.0, ["detergent", "laundry", "washing powder"], "Front-load detergent powder.", "A5-L-1-2"),
    ("HHD-002", "Ariel Matic Liquid Detergent 1 L", "household", "Ariel", "1 L", 265, 175, 190, None, 1.0, ["detergent", "laundry", "liquid detergent"], "Liquid laundry detergent.", "A5-L-2-1"),
    ("HHD-003", "Tide Detergent Powder 1 kg", "household", "Tide", "1 kg", 135, 102, 108, None, 1.0, ["detergent", "laundry", "washing powder"], "Detergent powder.", "A5-L-2-3"),
    ("HHD-004", "Vim Dishwash Gel 500 ml", "household", "Vim", "500 ml", 110, 80, 85, None, 0.5, ["dishwash", "cleaning"], "Lemon dishwash gel.", "A5-R-1-3"),
    ("HHD-005", "Harpic Toilet Cleaner 500 ml", "household", "Harpic", "500 ml", 99, 72, 76, None, 0.5, ["toilet cleaner", "cleaning"], "Disinfectant toilet cleaner.", "A5-R-2-3"),
    ("BAB-001", "Pampers Active Baby Diapers Medium (56 pc)", "baby", "Pampers", "56 pc", 999, 780, 820, None, 1.6, ["diapers", "baby"], "Taped diapers, size M.", "A5-R-4-2"),
    ("BAB-002", "Huggies Wonder Pants Diapers Large (42 pc)", "baby", "Huggies", "42 pc", 849, 660, 700, None, 1.4, ["diapers", "diaper pants", "baby"], "Pant-style diapers, size L.", "A5-R-4-3"),
    ("ELE-001", "Canon EOS 1500D DSLR Camera Kit", "electronics", "Canon", "1 pc", 38999, 34200, 35500, None, 0.9, ["camera", "dslr", "photography"], "24.1 MP DSLR with 18-55 mm lens. Uses SD/SDHC/SDXC cards.", "A6-L-2-3"),
    ("ELE-002", "Sony ZV-1F Vlog Camera", "electronics", "Sony", "1 pc", 49990, 44500, 46000, None, 0.3, ["camera", "vlog camera", "photography"], "Compact vlogging camera. Uses SD cards.", "A6-L-2-4"),
    ("ELE-003", "SanDisk Ultra 64 GB SDXC Memory Card", "electronics", "SanDisk", "1 pc", 899, 600, 650, None, 0.01, ["memory card", "sd card", "storage", "photography"], "Class 10 UHS-I SDXC card for cameras.", "A6-L-3-3"),
    ("ELE-004", "SanDisk 128 GB microSD Memory Card", "electronics", "SanDisk", "1 pc", 1199, 820, 880, None, 0.01, ["memory card", "microsd", "storage"], "microSDXC card with SD adapter.", "A6-L-3-4"),
    ("ELE-005", "Noise ColorFit Pro 5 Smart Watch", "electronics", "Noise", "1 pc", 3499, 2500, 2700, None, 0.1, ["smart watch", "wearable"], "AMOLED smartwatch with Bluetooth calling.", "A6-L-1-3"),
    ("ELE-006", "Samsung Galaxy Watch 6 Smart Watch", "electronics", "Samsung", "1 pc", 26999, 22800, 23800, None, 0.1, ["smart watch", "wearable"], "Wear OS smartwatch.", "A6-L-1-4"),
    ("ELE-007", "DSLR Camera Shoulder Bag", "electronics", "AmazonBasics", "1 pc", 1499, 900, 1000, None, 0.6, ["camera bag", "photography"], "Padded bag for DSLR and lenses.", "A6-L-4-3"),
    ("ELE-008", "25W USB-C Fast Charger", "electronics", "Samsung", "1 pc", 1299, 850, 900, None, 0.1, ["charger", "power adapter"], "USB-C PD fast charging adapter.", "A6-R-1-3"),
    ("ELE-009", "10000 mAh Power Bank", "electronics", "Mi", "1 pc", 1499, 1000, 1100, None, 0.25, ["power bank", "charger"], "Portable power bank.", "A6-R-1-4"),
    ("SEA-001", "Folding Umbrella (3-fold)", "seasonal", "Citizen", "1 pc", 399, 250, 280, None, 0.35, ["umbrella", "rain", "monsoon"], "Compact automatic umbrella.", "A6-R-3-3"),
    ("SEA-002", "Large Golf Umbrella", "seasonal", "Citizen", "1 pc", 699, 450, 500, None, 0.7, ["umbrella", "rain", "monsoon"], "Large double-canopy umbrella.", "A6-R-3-2"),
    ("SEA-003", "Waterproof Raincoat", "seasonal", "Zeel", "1 pc", 599, 380, 420, None, 0.5, ["raincoat", "rain", "monsoon"], "Hooded raincoat with pants.", "A6-R-4-3"),
    ("FRZ-001", "Vanilla Ice Cream 1 L", "frozen", "Amul", "1 L", 250, 180, 190, 180, 0.6, ["ice cream", "dessert"], "Vanilla ice cream tub.", "Z-1-2"),
    ("FRZ-002", "Frozen Green Peas 500 g", "frozen", "Safal", "500 g", 120, 85, 90, 180, 0.5, ["peas", "frozen vegetables"], "Frozen green peas.", "Z-2-2"),
    ("GFT-001", "FreshMart Gift Card ₹500", "gift-cards", "FreshMart", "1 pc", 500, 500, 500, None, 0.0, ["gift card"], "Store gift card (ask at the service desk).", None),
]

# Shopping missions: (name, weight, [(item_group_probability, [(sku, share), ...]), ...])
MISSIONS = [
    ("breakfast", 0.22, [
        (0.85, [("MLK-001", 0.6), ("MLK-002", 0.3), ("MLK-003", 0.1)]),
        (0.70, [("BRD-001", 0.5), ("BRD-002", 0.3), ("BRD-003", 0.2)]),
        (0.55, [("EGG-001", 0.7), ("EGG-002", 0.3)]),
        (0.35, [("DRY-001", 1.0)]),
        (0.20, [("SPR-001", 1.0)]),
        (0.20, [("CER-001", 0.5), ("CER-002", 0.3), ("CER-003", 0.2)]),
        (0.15, [("COF-001", 0.5), ("COF-002", 0.3), ("COF-003", 0.2)]),
        (0.30, [("FRU-001", 1.0)]),
        (0.10, [("JUC-001", 1.0)]),
        (0.08, [("SPR-002", 1.0)]),
        (0.05, [("HNY-001", 1.0)]),
        (0.06, [("BKY-002", 1.0)]),
    ]),
    ("tea_time", 0.14, [
        (0.75, [("TEA-001", 0.55), ("TEA-002", 0.35), ("TEA-003", 0.10)]),
        (0.50, [("MLK-001", 0.7), ("MLK-002", 0.3)]),
        (0.70, [("BIS-001", 0.55), ("BIS-002", 0.45)]),
        (0.30, [("STP-006", 1.0)]),
    ]),
    ("snacks", 0.12, [
        (0.70, [("SNK-001", 1.0)]),
        (0.60, [("BEV-001", 1.0)]),
        (0.55, [("CHO-001", 0.35), ("CHO-002", 0.3), ("CHO-003", 0.25), ("CHO-004", 0.1)]),
        (0.30, [("SNK-002", 1.0)]),
        (0.25, [("FRZ-001", 1.0)]),
        (0.30, [("BEV-002", 1.0)]),
    ]),
    ("household", 0.10, [
        (0.70, [("HHD-001", 0.35), ("HHD-002", 0.4), ("HHD-003", 0.25)]),
        (0.50, [("HHD-004", 1.0)]),
        (0.30, [("HHD-005", 1.0)]),
    ]),
    ("personal_care", 0.09, [
        (0.60, [("PRC-001", 0.7), ("PRC-002", 0.3)]),
        (0.40, [("PRC-003", 1.0)]),
        (0.35, [("PRC-004", 1.0)]),
        (0.45, [("PRC-005", 1.0)]),
    ]),
    ("baby", 0.06, [
        (0.90, [("BAB-001", 0.55), ("BAB-002", 0.45)]),
        (0.65, [("BAB-003", 1.0)]),
    ]),
    ("staples", 0.12, [
        (0.50, [("STP-001", 1.0)]), (0.50, [("STP-002", 1.0)]), (0.45, [("STP-003", 1.0)]),
        (0.45, [("STP-004", 1.0)]), (0.30, [("STP-005", 1.0)]), (0.30, [("STP-006", 1.0)]),
        (0.40, [("VEG-002", 1.0)]), (0.45, [("VEG-001", 1.0)]),
    ]),
    ("fresh", 0.10, [
        (0.50, [("FRU-001", 1.0)]), (0.40, [("FRU-002", 1.0)]), (0.50, [("VEG-001", 1.0)]),
        (0.50, [("VEG-002", 1.0)]), (0.25, [("DRY-004", 1.0)]), (0.40, [("DRY-002", 1.0)]),
        (0.15, [("BKY-001", 1.0)]), (0.10, [("DRY-003", 1.0)]), (0.15, [("FRZ-002", 1.0)]),
    ]),
    ("electronics", 0.025, [
        (0.35, [("ELE-001", 0.7), ("ELE-002", 0.3)]),
        (0.25, [("ELE-005", 0.75), ("ELE-006", 0.25)]),
        (0.30, [("ELE-003", 0.6), ("ELE-004", 0.4)]),
        (0.20, [("ELE-009", 1.0)]),
        (0.15, [("ELE-008", 1.0)]),
    ]),
]

# Conditional accessories: if the first SKU is in the basket, add the second with probability p.
ACCESSORY_RULES = [
    ("ELE-001", "ELE-003", 0.70), ("ELE-001", "ELE-007", 0.40), ("ELE-002", "ELE-003", 0.65),
    ("ELE-005", "ELE-008", 0.35), ("ELE-006", "ELE-008", 0.45), ("PRC-001", "PRC-003", 0.25),
]

RAIN_MISSION = ("rainy_day", [
    (0.60, [("SEA-001", 0.65), ("SEA-002", 0.35)]),
    (0.30, [("SEA-003", 1.0)]),
    (0.35, [("BEV-003", 1.0)]),
    (0.30, [("TEA-001", 1.0)]),
    (0.15, [("BEV-004", 1.0)]),
])

CURATED_RELATIONS = [
    ("ELE-001", "ELE-003", "compatible_accessory", "SD/SDXC card compatible with the Canon EOS 1500D."),
    ("ELE-001", "ELE-007", "compatible_accessory", "Fits the camera body with the kit lens."),
    ("ELE-002", "ELE-003", "compatible_accessory", "The ZV-1F records to SD cards; UHS-I recommended."),
    ("ELE-006", "ELE-008", "compatible_accessory", "USB-C adapter for the Galaxy Watch charging puck."),
    ("ELE-005", "ELE-008", "complement", "Charging adapter (cable included with the watch)."),
    ("CER-001", "MLK-001", "complement", None),
]

# UrbanBasket (second tenant) sells a subset at its own prices (multiplier) - used for isolation tests.
URBANBASKET_SKUS = ["MLK-001", "MLK-002", "EGG-001", "BRD-001", "BRD-002", "DRY-001", "CHO-001", "CHO-003",
                    "COF-001", "TEA-001", "BIS-001", "SNK-001", "BEV-001", "HHD-002", "HHD-004", "BAB-001",
                    "BAB-003", "PRC-001", "STP-003", "STP-004", "FRU-001", "VEG-001", "SEA-001", "ELE-003",
                    "ELE-005"]
