"""
Dev seed script — spreadsheet testing dataset.

Usage (from backend/):
    DATABASE_URL="postgresql://vendora:vendora@localhost:5432/vendora_test" \\
        python3 seed_dev.py [email]

Defaults to the canonical personal test account if no email is given.
What it does:
  1. Initializes the DB schema (safe to run on existing DB — create_all is idempotent)
  2. Creates/upgrades the target account to Pro tier
  3. Seeds 80+ realistic inventory items across mixed categories
  4. Prints how to export the CSV
"""
import os
import sys
import uuid
from decimal import Decimal
from urllib.parse import quote_plus

sys.path.insert(0, os.path.dirname(__file__))

# ─── DB bootstrap ────────────────────────────────────────────────────────────

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.models.base import Base
from app.models.user import User  # noqa: F401 — register model
from app.models.inventory import (  # noqa: F401 — register model
    InventoryItem, InventoryStockLedger, InventoryExternalLink,
    InventoryImportJob, InventoryImportRow,
)
from app.models.transaction import Transaction  # noqa: F401
from app.models.invoice import Invoice, InvoiceItem  # noqa: F401
from app.models.subscription import Subscription, WebhookEvent  # noqa: F401
from app.models.integration import LightspeedToken  # noqa: F401
from app.models.square import SquareCredential  # noqa: F401
from app.models.clover import CloverCredential  # noqa: F401
from app.models.provider import ProviderSyncRun, ReconciliationIssue, ProviderWebhookEvent  # noqa: F401
from app.services.auth import hash_password

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://vendora:vendora@localhost:5432/vendora_test",
)

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

TARGET_EMAIL    = sys.argv[1] if len(sys.argv) > 1 else "thegamermasterninja@gmail.com"
TARGET_PASSWORD = "Alexander1221"
TARGET_BUSINESS = "Ninja Resale"

# ─── Seed data ────────────────────────────────────────────────────────────────

ITEMS = [
    # ── Electronics ───────────────────────────────────────────────────────────
    dict(name="iPhone 13 128GB",        category="Electronics", sku="APPL-IP13-128",  color="Midnight",    condition="Good",      quantity=3, buy_price="280.00", expected_sell_price="420.00", platform="eBay",     source="lightspeed", vendor_name="Tech Resale Co"),
    dict(name="iPhone 14 256GB",        category="Electronics", sku="APPL-IP14-256",  color="Starlight",   condition="Like New",  quantity=2, buy_price="480.00", expected_sell_price="660.00", platform="eBay",     source="lightspeed", vendor_name="Tech Resale Co"),
    dict(name="Samsung Galaxy S23",     category="Electronics", sku="SAMS-S23-256",   color="Phantom Black", condition="Good",    quantity=4, buy_price="320.00", expected_sell_price="460.00", platform="eBay",     source="manual",     vendor_name="Metro Wireless"),
    dict(name="Google Pixel 7",         category="Electronics", sku="GOOG-PX7-128",   color="Snow",        condition="Fair",      quantity=2, buy_price="180.00", expected_sell_price="260.00", platform="Mercari",  source="manual",     vendor_name="Metro Wireless"),
    dict(name="iPad Air 5th Gen 64GB",  category="Electronics", sku="APPL-IPA5-64",   color="Space Gray",  condition="Good",      quantity=2, buy_price="330.00", expected_sell_price="480.00", platform="eBay",     source="lightspeed", vendor_name="Tech Resale Co"),
    dict(name="iPad Mini 6 256GB",      category="Electronics", sku="APPL-IPM6-256",  color="Purple",      condition="Like New",  quantity=1, buy_price="440.00", expected_sell_price="570.00", platform="eBay",     source="lightspeed", vendor_name="Tech Resale Co"),
    dict(name="MacBook Air M1 8GB",     category="Electronics", sku="APPL-MBA-M1-8",  color="Gold",        condition="Good",      quantity=1, buy_price="650.00", expected_sell_price="870.00", platform="eBay",     source="manual",     vendor_name="Budget Laptops LLC"),
    dict(name="PS5 Disc Edition",       category="Gaming",      sku="SONY-PS5-DISC",  color="White",       condition="Like New",  quantity=2, buy_price="380.00", expected_sell_price="480.00", platform="eBay",     source="lightspeed", vendor_name="GameStop Wholesale"),
    dict(name="Nintendo Switch OLED",   category="Gaming",      sku="NINT-SWO-WHT",   color="White",       condition="Good",      quantity=3, buy_price="240.00", expected_sell_price="310.00", platform="eBay",     source="manual",     vendor_name="GameStop Wholesale"),
    dict(name="Xbox Series X",          category="Gaming",      sku="XBOX-SX-BLK",    color="Black",       condition="Like New",  quantity=1, buy_price="380.00", expected_sell_price="460.00", platform="eBay",     source="lightspeed", vendor_name="GameStop Wholesale"),
    dict(name="Sony WH-1000XM5",        category="Audio",       sku="SONY-WH-XM5",    color="Midnight Black", condition="Good",  quantity=5, buy_price="140.00", expected_sell_price="220.00", platform="eBay",     source="manual",     vendor_name="Audio Surplus"),
    dict(name="AirPods Pro 2nd Gen",    category="Audio",       sku="APPL-APP-2G",    color="White",       condition="Good",      quantity=6, buy_price="130.00", expected_sell_price="195.00", platform="eBay",     source="lightspeed", vendor_name="Tech Resale Co"),
    dict(name="Bose QuietComfort 45",   category="Audio",       sku="BOSE-QC45-BLK",  color="Black",       condition="Like New",  quantity=2, buy_price="150.00", expected_sell_price="240.00", platform="Amazon",   source="manual",     vendor_name="Audio Surplus"),
    dict(name="DJI Mini 3 Pro",         category="Electronics", sku="DJI-M3P-001",                         condition="Good",      quantity=1, buy_price="450.00", expected_sell_price="620.00", platform="eBay",     source="manual",     vendor_name="Drone Depot"),
    dict(name="GoPro Hero 11",          category="Electronics", sku="GPRO-H11-BLK",   color="Black",       condition="Like New",  quantity=2, buy_price="200.00", expected_sell_price="290.00", platform="eBay",     source="manual",     vendor_name="Drone Depot"),

    # ── Sneakers ──────────────────────────────────────────────────────────────
    dict(name="Nike Air Jordan 1 Retro High OG",    category="Sneakers", sku="NKE-AJ1-HOG-10",  size="10", color="Bred",         condition="New",      quantity=1, buy_price="160.00", expected_sell_price="380.00", platform="StockX",  source="manual",      notes="DS, OG box",                vendor_name="Kick Game Supply"),
    dict(name="Nike Air Jordan 1 Retro High OG",    category="Sneakers", sku="NKE-AJ1-HOG-11",  size="11", color="Bred",         condition="New",      quantity=1, buy_price="160.00", expected_sell_price="340.00", platform="StockX",  source="manual",      notes="DS, OG box",                vendor_name="Kick Game Supply"),
    dict(name="Nike Dunk Low Panda",                category="Sneakers", sku="NKE-DLW-PND-9",   size="9",  color="White/Black",  condition="New",      quantity=2, buy_price="110.00", expected_sell_price="185.00", platform="GOAT",    source="manual",      vendor_name="Kick Game Supply"),
    dict(name="Nike Dunk Low Panda",                category="Sneakers", sku="NKE-DLW-PND-10",  size="10", color="White/Black",  condition="New",      quantity=2, buy_price="110.00", expected_sell_price="175.00", platform="GOAT",    source="manual",      vendor_name="Kick Game Supply"),
    dict(name="Adidas Yeezy 350 V2 Zebra",          category="Sneakers", sku="ADI-YZY-ZBR-10",  size="10", color="Zebra",        condition="New",      quantity=1, buy_price="220.00", expected_sell_price="360.00", platform="StockX",  source="lightspeed",  vendor_name="Sneaker District"),
    dict(name="Adidas Yeezy Slide Pure",            category="Sneakers", sku="ADI-YZY-SLD-10",  size="10", color="Pure",         condition="Like New", quantity=1, buy_price="60.00",  expected_sell_price="110.00", platform="eBay",    source="manual",      vendor_name="Sneaker District"),
    dict(name="New Balance 550 White/Navy",         category="Sneakers", sku="NB-550-WHN-11",   size="11", color="White/Navy",   condition="New",      quantity=2, buy_price="90.00",  expected_sell_price="155.00", platform="GOAT",    source="manual",      vendor_name="Kick Game Supply"),
    dict(name="Jordan 4 Retro Military Blue",       category="Sneakers", sku="NKE-AJ4-MLB-9",   size="9",  color="Military Blue", condition="New",     quantity=1, buy_price="240.00", expected_sell_price="420.00", platform="StockX",  source="lightspeed",  notes="2024 retro, OG box",        vendor_name="Sneaker District"),

    # ── Clothing — Streetwear ─────────────────────────────────────────────────
    dict(name="Supreme Box Logo Hoodie FW23",  category="Streetwear",  sku="SUP-BLH-FW23-L",  size="L",  color="Black",      condition="New",      quantity=1, buy_price="168.00", expected_sell_price="340.00", platform="eBay",    source="manual",      vendor_name="Hype Collective"),
    dict(name="Supreme Box Logo Hoodie FW23",  category="Streetwear",  sku="SUP-BLH-FW23-XL", size="XL", color="Black",      condition="New",      quantity=1, buy_price="168.00", expected_sell_price="310.00", platform="eBay",    source="manual",      vendor_name="Hype Collective"),
    dict(name="Palace Tri-Ferg Hoodie",        category="Streetwear",  sku="PAL-TFH-NAV-M",   size="M",  color="Navy",       condition="Like New", quantity=2, buy_price="80.00",  expected_sell_price="145.00", platform="Depop",   source="manual",      vendor_name="Hype Collective"),
    dict(name="Stussy Basic Logo Tee",         category="Streetwear",  sku="STU-BLT-WHT-L",   size="L",  color="White",      condition="New",      quantity=4, buy_price="30.00",  expected_sell_price="55.00",  platform="Depop",   source="manual",      vendor_name="Hype Collective"),
    dict(name="Carhartt WIP Detroit Jacket",   category="Outerwear",   sku="CAR-WIP-DJK-XL",  size="XL", color="Hamilton Brown", condition="Good",  quantity=1, buy_price="85.00",  expected_sell_price="155.00", platform="eBay",    source="manual",      vendor_name="Vintage Vault"),
    dict(name="North Face 700 Nuptse Puffer",  category="Outerwear",   sku="TNF-700-NUP-L",   size="L",  color="Black",      condition="Good",      quantity=2, buy_price="120.00", expected_sell_price="195.00", platform="eBay",    source="lightspeed",  vendor_name="Outdoor Surplus"),
    dict(name="Levi's 501 Original Jeans",     category="Clothing",    sku="LEV-501-34x30",   size="34x30", color="Indigo",  condition="Good",      quantity=3, buy_price="28.00",  expected_sell_price="55.00",  platform="Poshmark", source="manual",     vendor_name="Vintage Vault"),
    dict(name="Vintage Starter Jacket NFL",    category="Outerwear",   sku="VTG-STR-NFL-L",   size="L",  color="Black/Gold",  condition="Fair",     quantity=1, buy_price="45.00",  expected_sell_price="120.00", platform="eBay",    source="manual",      notes="90s vintage, minor fading", vendor_name="Vintage Vault"),
    dict(name="Ralph Lauren Polo Shirt",       category="Clothing",    sku="RLP-POL-BLU-M",   size="M",  color="Blue",       condition="Good",      quantity=5, buy_price="18.00",  expected_sell_price="38.00",  platform="Poshmark", source="manual",     vendor_name="Thrift Connect"),
    dict(name="Champion Reverse Weave Hoodie", category="Streetwear",  sku="CHP-RWH-OXF-L",   size="L",  color="Oxford Gray", condition="Good",     quantity=3, buy_price="25.00",  expected_sell_price="50.00",  platform="Depop",   source="manual",      vendor_name="Thrift Connect"),
    dict(name="Patagonia Better Sweater",      category="Outerwear",   sku="PAT-BSW-NAV-M",   size="M",  color="Navy",       condition="Like New",  quantity=2, buy_price="65.00",  expected_sell_price="105.00", platform="eBay",    source="manual",      vendor_name="Outdoor Surplus"),

    # ── Bags & Accessories ────────────────────────────────────────────────────
    dict(name="Louis Vuitton Neverfull MM",    category="Bags",        sku="LV-NVF-MM-MON",              color="Monogram",   condition="Good",      quantity=1, buy_price="680.00", expected_sell_price="1050.00", platform="TheRealReal", source="lightspeed", vendor_name="Luxury Consign"),
    dict(name="Gucci Crossbody Messenger",     category="Bags",        sku="GUC-CBM-BLK",                color="Black",      condition="Good",      quantity=1, buy_price="320.00", expected_sell_price="580.00",  platform="eBay",    source="manual",                           vendor_name="Luxury Consign"),
    dict(name="Nike Tech Fleece Pants",        category="Clothing",    sku="NKE-TFP-BLK-M",   size="M",  color="Black",      condition="New",       quantity=4, buy_price="48.00",  expected_sell_price="85.00",  platform="eBay",    source="lightspeed",  vendor_name="Kick Game Supply"),
    dict(name="Goyard Saint Louis PM Tote",    category="Bags",                                           color="Chevron",    condition="Good",      quantity=1, buy_price="520.00", expected_sell_price="820.00",  platform="TheRealReal", source="manual",     vendor_name="Luxury Consign"),
    dict(name="Coach Tabby Shoulder Bag",      category="Bags",        sku="COA-TAB-TAN",                color="Tan",        condition="Like New",   quantity=1, buy_price="110.00", expected_sell_price="195.00",  platform="Poshmark", source="manual",     vendor_name="Thrift Connect"),

    # ── Trading Cards / Collectibles ─────────────────────────────────────────
    dict(name="Pokemon Charizard VMAX 074/073 PSA 9",  category="Trading Cards",  sku="PKM-CZRD-VX-PSA9",     condition="Graded PSA 9",  quantity=1, buy_price="55.00",  expected_sell_price="120.00", platform="eBay",    source="manual",      notes="Shining Fates",  vendor_name="Card Vault"),
    dict(name="Pokemon Pikachu VMAX 044/185 PSA 10",   category="Trading Cards",  sku="PKM-PIKA-VX-PSA10",    condition="Graded PSA 10", quantity=1, buy_price="85.00",  expected_sell_price="190.00", platform="eBay",    source="manual",      notes="Vivid Voltage",  vendor_name="Card Vault"),
    dict(name="Pokemon Booster Pack Scarlet & Violet", category="Trading Cards",  sku="PKM-BP-SV-001",        condition="Sealed",        quantity=12, buy_price="3.80",  expected_sell_price="7.50",   platform="eBay",    source="lightspeed",                            vendor_name="Card Vault"),
    dict(name="Topps Series 1 Baseball Hobby Box 2024",category="Trading Cards",  sku="TPP-BS1-HBX-24",       condition="Sealed",        quantity=2,  buy_price="68.00", expected_sell_price="95.00",  platform="eBay",    source="lightspeed",                            vendor_name="Card Vault"),
    dict(name="Star Wars LEGO Millennium Falcon 75192",category="Collectibles",   sku="LGO-SW-MF-75192",      condition="New Sealed",    quantity=1, buy_price="480.00", expected_sell_price="680.00", platform="eBay",    source="manual",                                vendor_name="Brick Surplus"),
    dict(name="LEGO City Police Station 60316",         category="Collectibles",  sku="LGO-CTY-PS-60316",     condition="New Sealed",    quantity=2, buy_price="95.00",  expected_sell_price="140.00", platform="eBay",    source="manual",                                vendor_name="Brick Surplus"),
    dict(name="Hot Wheels RLC Exclusive Bone Shaker",   category="Collectibles",  sku="HW-RLC-BNSH-2024",     condition="New Sealed",    quantity=3, buy_price="20.00",  expected_sell_price="48.00",  platform="eBay",    source="manual",                                vendor_name="Collectable Hub"),
    dict(name="Funko Pop Batman #01 CHASE",             category="Collectibles",  sku="FNK-BAT-01-CHASE",     condition="New in Box",    quantity=1, buy_price="22.00",  expected_sell_price="55.00",  platform="eBay",    source="manual",                                vendor_name="Collectable Hub"),

    # ── Watches / Jewelry ────────────────────────────────────────────────────
    dict(name="Casio G-Shock GA-2100",         category="Watches",     sku="CAS-GSH-GA2100-BLK",  color="Black",      condition="Like New",  quantity=2, buy_price="55.00",  expected_sell_price="90.00",  platform="eBay",    source="manual",      vendor_name="Time Traders"),
    dict(name="Seiko 5 Sports SRPD55",         category="Watches",     sku="SEK-5SP-SRPD55",       color="Blue",       condition="Good",      quantity=1, buy_price="80.00",  expected_sell_price="145.00", platform="eBay",    source="manual",      vendor_name="Time Traders"),
    dict(name="Apple Watch Series 8 45mm",     category="Watches",     sku="APPL-AW8-45-BLK",     color="Midnight",   condition="Good",      quantity=2, buy_price="210.00", expected_sell_price="310.00", platform="eBay",    source="lightspeed",  vendor_name="Tech Resale Co"),
    dict(name="Fossil Gen 6 Smartwatch",       category="Watches",     sku="FSL-GEN6-BLK",         color="Black",      condition="Good",      quantity=1, buy_price="70.00",  expected_sell_price="120.00", platform="eBay",    source="manual",      vendor_name="Time Traders"),

    # ── Books / Media ────────────────────────────────────────────────────────
    dict(name="Atomic Habits (James Clear)",           category="Books",       sku="BK-AH-CLEAR",          condition="Good",      quantity=8, buy_price="3.50",   expected_sell_price="10.00",  platform="Amazon",  source="manual",      notes="Paperback", vendor_name="Book Depot"),
    dict(name="The Lean Startup (Eric Ries)",          category="Books",       sku="BK-LS-RIES",           condition="Good",      quantity=5, buy_price="3.00",   expected_sell_price="9.00",   platform="Amazon",  source="manual",      notes="Paperback", vendor_name="Book Depot"),
    dict(name="Harry Potter Box Set (1-7, HC)",        category="Books",       sku="BK-HP-BXST-HC",        condition="Good",      quantity=2, buy_price="35.00",  expected_sell_price="75.00",  platform="eBay",    source="manual",                         vendor_name="Book Depot"),

    # ── Home & Lifestyle ─────────────────────────────────────────────────────
    dict(name="Dyson V11 Torque Drive Cordless",       category="Home",        sku="DYS-V11-TDR",          color="Iron/Nickel",  condition="Good",     quantity=1, buy_price="180.00", expected_sell_price="290.00", platform="eBay",    source="manual",     vendor_name="Home Surplus Co"),
    dict(name="Dyson Supersonic Hair Dryer",           category="Home",        sku="DYS-SHD-COP",          color="Copper/Black", condition="Like New", quantity=1, buy_price="210.00", expected_sell_price="320.00", platform="eBay",    source="manual",     vendor_name="Home Surplus Co"),
    dict(name="Instant Pot Duo 7-in-1 8Qt",            category="Home",        sku="INP-DUO-8QT",          color="Stainless",    condition="Good",     quantity=2, buy_price="55.00",  expected_sell_price="90.00",  platform="Amazon",  source="lightspeed", vendor_name="Home Surplus Co"),
    dict(name="Vitamix 5200 Blender",                  category="Home",        sku="VTX-5200-BLK",         color="Black",        condition="Good",     quantity=1, buy_price="140.00", expected_sell_price="220.00", platform="eBay",    source="manual",     vendor_name="Home Surplus Co"),
    dict(name="Le Creuset Dutch Oven 5.5qt",           category="Home",        sku="LCR-DO-55-RED",        color="Flame Red",    condition="Good",     quantity=1, buy_price="95.00",  expected_sell_price="180.00", platform="eBay",    source="manual",     vendor_name="Home Surplus Co"),

    # ── Sports / Outdoor ────────────────────────────────────────────────────
    dict(name="Callaway Apex Pro Irons Set",           category="Golf",        sku="CAL-APX-PRO-IRNS",     condition="Good",      quantity=1, buy_price="380.00", expected_sell_price="580.00", platform="eBay",    source="manual",     vendor_name="Golf Resellers Inc"),
    dict(name="TaylorMade Stealth Driver 10.5deg",     category="Golf",        sku="TYM-STH-DRV-10",       condition="Like New",  quantity=1, buy_price="220.00", expected_sell_price="330.00", platform="eBay",    source="manual",     vendor_name="Golf Resellers Inc"),
    dict(name="Hydro Flask 40oz Wide Mouth",           category="Outdoor",     sku="HFL-40WM-BLK",         color="Black",         condition="Good",     quantity=6, buy_price="22.00",  expected_sell_price="40.00",  platform="eBay",    source="manual",     vendor_name="Outdoor Surplus"),
    dict(name="Stanley Quencher 40oz",                 category="Home",        sku="STN-QCH-40-CRM",       color="Cream",         condition="New",      quantity=4, buy_price="20.00",  expected_sell_price="40.00",  platform="Amazon",  source="lightspeed",  notes="2024 color drop", vendor_name="Home Surplus Co"),
    dict(name="Yeti Rambler 30oz Tumbler",             category="Outdoor",     sku="YET-RMB-30-BLK",       color="Black",         condition="New",      quantity=5, buy_price="28.00",  expected_sell_price="45.00",  platform="Amazon",  source="manual",      vendor_name="Outdoor Surplus"),

    # ── Musical Instruments ─────────────────────────────────────────────────
    dict(name="Fender Player Stratocaster",            category="Music",       sku="FND-PLR-STR-BLK",      color="Black",         condition="Good",     quantity=1, buy_price="380.00", expected_sell_price="560.00", platform="Reverb",  source="manual",      vendor_name="Gear Exchange"),
    dict(name="Roland FP-30X Digital Piano",           category="Music",       sku="ROL-FP30X-BLK",        color="Black",         condition="Like New", quantity=1, buy_price="340.00", expected_sell_price="480.00", platform="Reverb",  source="manual",      vendor_name="Gear Exchange"),

    # ── Photography ─────────────────────────────────────────────────────────
    dict(name="Canon EOS R10 Mirrorless Body",         category="Photography", sku="CAN-EOS-R10-BDY",      color="Black",         condition="Good",     quantity=1, buy_price="600.00", expected_sell_price="780.00", platform="eBay",    source="manual",      vendor_name="Camera Exchange"),
    dict(name="Sony 35mm f/1.8 FE Lens",               category="Photography", sku="SON-35F18-FE",         color="Black",         condition="Like New", quantity=1, buy_price="420.00", expected_sell_price="600.00", platform="eBay",    source="manual",      vendor_name="Camera Exchange"),

    # ── Accessories / Cables ─────────────────────────────────────────────────
    dict(name="Anker 100W GaN Charger",                category="Electronics", sku="ANK-100W-GAN",                                condition="New",       quantity=8, buy_price="22.00",  expected_sell_price="40.00",  platform="Amazon",  source="lightspeed",  vendor_name="Tech Resale Co"),
    dict(name="Magsafe Charger 15W",                   category="Electronics", sku="APPL-MGS-15W",         color="White",         condition="New",      quantity=6, buy_price="18.00",  expected_sell_price="32.00",  platform="Amazon",  source="lightspeed",  vendor_name="Tech Resale Co"),
    dict(name="USB-C Hub 7-in-1",                      category="Electronics", sku="USB-HUB-7IN1",         color="Silver",        condition="New",      quantity=5, buy_price="15.00",  expected_sell_price="28.00",  platform="Amazon",  source="manual",      vendor_name="Tech Resale Co"),

    # ── Additional variety items (makes export spreadsheet more realistic) ──
    dict(name="Nike Air Max 90 Infrared",              category="Sneakers",    sku="NKE-AM90-IRD-10", size="10", color="White/Black/Red", condition="Good",      quantity=1, buy_price="95.00",  expected_sell_price="175.00", platform="GOAT",    source="manual",      vendor_name="Kick Game Supply"),
    dict(name="Jordan 11 Retro Bred 2019",             category="Sneakers",    sku="NKE-AJ11-BRD-11", size="11", color="Black/Red",  condition="Good",          quantity=1, buy_price="185.00", expected_sell_price="300.00", platform="StockX",  source="manual",      notes="Minor creasing",           vendor_name="Sneaker District"),
    dict(name="Sony PlayStation 5 Controller",         category="Gaming",      sku="SONY-DS5-WHT",     color="White",     condition="Like New",                  quantity=4, buy_price="35.00",  expected_sell_price="60.00",  platform="Amazon",  source="lightspeed",  vendor_name="GameStop Wholesale"),
    dict(name="Meta Quest 3 128GB",                    category="Electronics", sku="META-Q3-128",                         condition="Good",                      quantity=1, buy_price="320.00", expected_sell_price="440.00", platform="eBay",    source="manual",      vendor_name="Tech Resale Co"),
    dict(name="Kindle Paperwhite 11th Gen",            category="Electronics", sku="AMZ-KPW-11",       color="Black",     condition="Like New",                  quantity=3, buy_price="60.00",  expected_sell_price="95.00",  platform="Amazon",  source="manual",      vendor_name="Book Depot"),
    dict(name="Weber Spirit II E-310 Grill",           category="Outdoor",     sku="WBR-SPT2-E310",    color="Black",     condition="Good",                      quantity=1, buy_price="280.00", expected_sell_price="400.00", platform="eBay",    source="manual",      notes="One season use",           vendor_name="Outdoor Surplus"),
    dict(name="Traeger Pro 575 Pellet Grill",          category="Outdoor",     sku="TRG-PRO-575",      color="Black",     condition="Good",                      quantity=1, buy_price="480.00", expected_sell_price="650.00", platform="eBay",    source="manual",      vendor_name="Outdoor Surplus"),
    dict(name="Titleist Pro V1x Golf Balls (Dozen)",   category="Golf",        sku="TTL-PRV1X-12",                        condition="Like New",                  quantity=6, buy_price="22.00",  expected_sell_price="38.00",  platform="eBay",    source="manual",      notes="2024 model",               vendor_name="Golf Resellers Inc"),
    dict(name="Bose SoundLink Flex Portable Speaker",  category="Audio",       sku="BOSE-SLF-BLK",     color="Black",     condition="Good",                      quantity=3, buy_price="65.00",  expected_sell_price="110.00", platform="Amazon",  source="manual",      vendor_name="Audio Surplus"),
    dict(name="JBL Flip 6 Bluetooth Speaker",          category="Audio",       sku="JBL-FLP6-BLK",     color="Black",     condition="Good",                      quantity=4, buy_price="42.00",  expected_sell_price="75.00",  platform="Amazon",  source="manual",      vendor_name="Audio Surplus"),
    dict(name="Air Jordan 1 Retro High Showcase Size Run", category="Sneakers", sku="SHOW-AJ1-SIZERUN", color="Black/Red/White", condition="New", quantity=7, buy_price="150.00", expected_sell_price="340.00", platform="StockX", source="manual", vendor_name="Kick Game Supply", notes="Showcase inventory item with per-size stock", custom_attributes={"variants": [{"size": "US 8", "quantity": 2}, {"size": "US 8.5", "quantity": 1}, {"size": "US 9", "quantity": 3}, {"size": "US 10", "quantity": 1}]}),
    dict(name="Essentials Tee Showcase Size Run", category="Streetwear", sku="SHOW-TEE-SIZERUN", color="Cream", condition="New", quantity=9, buy_price="18.00", expected_sell_price="42.00", platform="Depop", source="manual", vendor_name="Hype Collective", notes="Showcase apparel item with multiple sizes", custom_attributes={"variants": [{"size": "S", "quantity": 2}, {"size": "M", "quantity": 3}, {"size": "L", "quantity": 2}, {"size": "XL", "quantity": 2}]}),
]

assert len(ITEMS) >= 80, f"Expected >=80 seed items, got {len(ITEMS)}"


def build_placeholder_photo(name: str, side: str) -> str:
    label = quote_plus(f"{name[:28]} {side.title()}")
    background = "12122A" if side == "front" else "1E1E40"
    return f"https://placehold.co/720x720/{background}/FFFFFF.png?text={label}"


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    print(f"[seed_dev] DB: {DATABASE_URL}")
    print(f"[seed_dev] Target account: {TARGET_EMAIL}")

    # 1. Ensure schema exists (idempotent)
    print("[seed_dev] Ensuring schema...")
    with engine.connect() as conn:
        try:
            conn.execute(text("CREATE EXTENSION IF NOT EXISTS pgcrypto"))
            conn.commit()
        except Exception:
            conn.rollback()

    Base.metadata.create_all(bind=engine)
    print("[seed_dev] Schema OK.")

    db = SessionLocal()
    try:
        # 2. Create/upgrade user to Pro
        user = db.query(User).filter(User.email == TARGET_EMAIL).first()
        if user:
            user.subscription_tier = "pro"
            user.is_partner = True
            if TARGET_BUSINESS and not user.business_name:
                user.business_name = TARGET_BUSINESS
            db.commit()
            print(f"[seed_dev] User {TARGET_EMAIL} upgraded to Pro.")
        else:
            user = User(
                email=TARGET_EMAIL,
                password_hash=hash_password(TARGET_PASSWORD),
                business_name=TARGET_BUSINESS,
                subscription_tier="pro",
                is_partner=True,
            )
            db.add(user)
            db.commit()
            db.refresh(user)
            print(f"[seed_dev] Created user {TARGET_EMAIL} with Pro tier.")

        # 3. Seed inventory items (skip if sku already exists for this user)
        existing_by_sku = {
            it.sku.lower(): it
            for it in db.query(InventoryItem).filter(
                InventoryItem.user_id == user.id,
                InventoryItem.deleted_at.is_(None),
                InventoryItem.sku.isnot(None),
            ).all()
            if it.sku
        }

        created = 0
        updated = 0
        for spec in ITEMS:
            sku = spec.get("sku")
            photo_front = spec.get("photo_front_url") or build_placeholder_photo(spec["name"], "front")
            photo_back = spec.get("photo_back_url") or build_placeholder_photo(spec["name"], "back")
            custom_attributes = dict(spec.get("custom_attributes") or {})

            existing = existing_by_sku.get(sku.lower()) if sku else None
            if existing:
                existing.name = spec["name"]
                existing.category = spec.get("category")
                existing.size = spec.get("size")
                existing.color = spec.get("color")
                existing.condition = spec.get("condition", "Good")
                existing.quantity = int(spec.get("quantity", 1))
                existing.buy_price = Decimal(spec["buy_price"]) if spec.get("buy_price") else None
                existing.expected_sell_price = Decimal(spec["expected_sell_price"]) if spec.get("expected_sell_price") else None
                existing.platform = spec.get("platform")
                existing.vendor_name = spec.get("vendor_name")
                existing.notes = spec.get("notes")
                existing.source = spec.get("source", "manual")
                existing.status = "in_stock"
                existing.photo_front_url = photo_front
                existing.photo_back_url = photo_back
                existing.custom_attributes = custom_attributes
                db.add(existing)
                updated += 1
                continue

            item = InventoryItem(
                user_id=user.id,
                name=spec["name"],
                category=spec.get("category"),
                sku=sku,
                size=spec.get("size"),
                color=spec.get("color"),
                condition=spec.get("condition", "Good"),
                quantity=int(spec.get("quantity", 1)),
                buy_price=Decimal(spec["buy_price"]) if spec.get("buy_price") else None,
                expected_sell_price=Decimal(spec["expected_sell_price"]) if spec.get("expected_sell_price") else None,
                platform=spec.get("platform"),
                vendor_name=spec.get("vendor_name"),
                notes=spec.get("notes"),
                source=spec.get("source", "manual"),
                status="in_stock",
                photo_front_url=photo_front,
                photo_back_url=photo_back,
                custom_attributes=custom_attributes,
            )
            db.add(item)
            created += 1

        db.commit()
        total = db.query(InventoryItem).filter(
            InventoryItem.user_id == user.id,
            InventoryItem.deleted_at.is_(None),
        ).count()

        print(f"[seed_dev] Seeded {created} items ({updated} refreshed).")
        print(f"[seed_dev] Total active inventory for {TARGET_EMAIL}: {total} items.")

    finally:
        db.close()

    print()
    print("=" * 60)
    print("Dev spreadsheet testing is ready.")
    print()
    print("Local backend must be running on port 8000:")
    print("  DATABASE_URL=postgresql://vendora:vendora@localhost:5432/vendora_test \\")
    print("  uvicorn app.main:app --port 8000 --reload")
    print()
    print("1. Get a token:")
    print(f"  curl -s -X POST http://localhost:8000/api/v1/auth/login \\")
    print(f'    -H "Content-Type: application/json" \\')
    print(f'    -d \'{{"email":"{TARGET_EMAIL}","password":"{TARGET_PASSWORD}"}}\' | python3 -m json.tool')
    print()
    print("2. Export CSV (replace TOKEN):")
    print("  curl -s http://localhost:8000/api/v1/export/inventory \\")
    print('    -H "Authorization: Bearer TOKEN" > inventory_export.csv')
    print()
    print("3. Edit inventory_export.csv in a spreadsheet.")
    print()
    print("4. Re-import (preview then commit):")
    print("  curl -s -X POST http://localhost:8000/api/v1/inventory/imports/preview \\")
    print('    -H "Authorization: Bearer TOKEN" \\')
    print('    -F "file=@inventory_export.csv" | python3 -m json.tool')
    print("  # Take job_id from preview, then:")
    print("  curl -s -X POST http://localhost:8000/api/v1/inventory/imports/<JOB_ID>/commit \\")
    print('    -H "Authorization: Bearer TOKEN" | python3 -m json.tool')
    print("=" * 60)


if __name__ == "__main__":
    main()
