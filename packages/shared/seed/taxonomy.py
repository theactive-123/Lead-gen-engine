"""
Generates migration 010 (niche taxonomy) from the structure below.
Migration 010 holds the original seed; reviews after that are applied as idempotent deltas (011, 012, ...).
This file always reflects the CURRENT taxonomy (= 010 + deltas), for a readable overview and fresh setups.
Terms are matched case-insensitively on whole words; single words also match a plural "s"/"es".
"""
import json

GROUPS = {
  # key: (name, gate, saturation, excluded_by_default, description)
  'dtc':         ('DTC ecommerce brands', 'store', 'low', False, 'Independent brands selling online; requires real store evidence.'),
  'white_label': ('White-label service buyers', 'services', 'low', False, 'Agencies and service firms that resell web/design work.'),
  'wellness':    ('Wellness & fitness', 'booking', 'low', False, 'Studios, coaches and practitioners; booking widgets are a strong signal.'),
  'other':       ('Other low-saturation niches', 'none', 'medium', False, 'Manufacturers, contractors, hospitality, beverages, courses, makers.'),
  'saturated':   ('Saturated / excluded', 'none', 'high', True, 'Heavily pitched or non-commercial; recognised so they are not mislabelled.'),
}

# sub-niche key: (group, name, positive terms, negative terms)
SUB = {
  # ---- A. DTC ----
  'supplements': ('dtc', 'Supplements & functional nutrition',
    ['supplement', 'vitamin', 'multivitamin', 'protein powder', 'collagen', 'probiotic', 'nootropic', 'electrolyte', 'creatine', 'pre-workout',
     'gummies', 'adaptogen', 'superfood', 'greens powder', 'omega-3', 'magnesium', 'ashwagandha', 'functional mushroom', 'mushroom extract'], []),
  'clean_beauty': ('dtc', 'Clean beauty & skincare',
    ['skincare', 'skin care', 'serum', 'moisturizer', 'moisturiser', 'cleanser', 'face oil', 'clean beauty', 'cosmetics', 'makeup', 'lip balm',
     'sunscreen', 'body lotion', 'toner', 'retinol', 'vegan beauty', 'face mask', 'body butter'], ['beauty salon', 'nail salon', 'med spa', 'botox']),
  'haircare': ('dtc', 'Haircare', ['shampoo', 'conditioner', 'hair care', 'haircare', 'hair oil', 'hair mask', 'hair growth', 'curl cream', 'scalp'],
    ['hair salon', 'barbershop', 'barber shop', 'book your appointment']),
  'mens_grooming': ('dtc', "Men's grooming", ['beard oil', 'beard balm', 'beard', 'shaving', 'shave', 'razor', 'aftershave', "men's grooming", 'pomade'],
    ['barbershop', 'barber shop']),
  'pet_products': ('dtc', 'Pet products', ['dog treats', 'dog food', 'cat food', 'pet food', 'dog collar', 'leash', 'pet supplies', 'pet accessories',
     'dog toys', 'cat toys', 'pet products', 'for dogs', 'for cats', 'dog bed', 'cat litter'],
    ['veterinary', 'vet clinic', 'animal hospital', 'dog boarding', 'kennels', 'dog daycare', 'pet sitting', 'dog walking',
     'dog training', 'dog trainer', 'k9 training', 'obedience training']),
  'coffee_tea': ('dtc', 'Coffee & tea', ['coffee beans', 'coffee roasters', 'roastery', 'roaster', 'espresso', 'single origin', 'whole bean',
     'loose leaf', 'matcha', 'chai', 'herbal tea', 'cold brew', 'coffee subscription', 'tea blends', 'ground coffee'], ['our menu', 'dine in']),
  'specialty_food': ('dtc', 'Specialty food & snacks', ['snacks', 'hot sauce', 'spices', 'seasoning', 'jerky', 'chocolate', 'honey', 'granola',
     'olive oil', 'preserves', 'baking mix', 'gourmet', 'artisan food', 'condiments', 'confectionery', 'candy', 'bbq sauce', 'spice blends'],
    ['restaurant', 'catering', 'reservations', 'dine in', 'our menu', 'takeaway']),
  'craft_beverages': ('dtc', 'Craft beverages (non-alcoholic)', ['non-alcoholic', 'alcohol-free', 'kombucha', 'sparkling water', 'functional beverage',
     'mocktail', 'adaptogenic drink', 'energy drink', 'zero proof', 'craft soda', 'prebiotic soda'], []),
  'home_kitchen': ('dtc', 'Home & kitchen goods', ['cookware', 'kitchenware', 'kitchen tools', 'knives', 'cutting board', 'bakeware', 'tableware',
     'dinnerware', 'glassware', 'mugs', 'home decor', 'homeware', 'bedding', 'towels', 'throw pillows', 'cushions', 'rugs', 'furniture', 'lamps', 'table lamps', 'pendant lights'], []),
  'home_fragrance': ('dtc', 'Home fragrance & candles', ['candle', 'soy candle', 'wax melts', 'reed diffuser', 'home fragrance', 'room spray', 'incense'], []),
  'eco_products': ('dtc', 'Sustainable / eco products', ['zero waste', 'plastic-free', 'plastic free', 'biodegradable', 'compostable', 'refillable',
     'eco-friendly products', 'sustainable products', 'organic cotton'], []),
  'outdoor_camping': ('dtc', 'Outdoor & camping gear', ['camping', 'hiking', 'backpacking', 'outdoor gear', 'tent', 'sleeping bag', 'trekking',
     'climbing gear', 'overlanding', 'survival gear', 'fishing gear', 'camp gear'], ['campground', 'rv park', 'campsite booking']),
  'cycling_fitness_gear': ('dtc', 'Cycling & fitness equipment', ['bicycle', 'cycling', 'e-bike', 'ebike', 'bike parts', 'gym equipment',
     'fitness equipment', 'dumbbell', 'kettlebell', 'resistance bands', 'yoga mat', 'rowing machine', 'treadmill', 'home gym'],
    ['bike rental', 'spin class', 'class schedule', 'motorcycle', 'motorbike']),
  'baby_kids': ('dtc', 'Baby & kids products', ['baby', 'toddler', 'kids clothing', 'nursery decor', 'nursery furniture', 'newborn', 'infant', 'toys', 'maternity', 'diaper',
     'nappies', 'stroller', 'baby clothes', 'kids toys'], ['daycare', 'childcare', 'preschool', 'pediatric', 'paediatric', 'elementary school', 'photographer', 'photography',
     'incontinence', 'adult diapers', 'charity', 'medical equipment']),
  'jewellery': ('dtc', 'Independent jewellery', ['jewelry', 'jewellery', 'necklace', 'earrings', 'bracelet', 'pendant', 'charms', 'sterling silver',
     'gemstone', 'engagement rings', 'fine jewelry', 'fine jewellery', 'handmade jewelry', 'rings'], ['pawn shop', 'we buy gold']),
  'apparel': ('dtc', 'Apparel (independent labels)', ['clothing', 'apparel', 't-shirts', 'tees', 'hoodies', 'dresses', 'streetwear', 'activewear',
     'swimwear', 'lingerie', 'denim', 'outerwear', 'knitwear', 'womenswear', 'menswear', 'footwear', 'sneakers'],
    ['school uniforms', 'dry cleaning', 'alterations']),
  # ---- B. White-label service buyers ----
  'marketing_agency': ('white_label', 'Digital marketing agencies', ['digital marketing agency', 'marketing agency', 'digital agency', 'creative agency',
     'full-service agency', 'inbound marketing', 'content marketing', 'growth marketing', 'marketing services', 'email marketing services'], ['free trial', 'saas']),
  'seo_agency': ('white_label', 'SEO agencies', ['seo agency', 'seo services', 'search engine optimization', 'search engine optimisation', 'local seo',
     'link building', 'technical seo', 'seo company', 'seo consultant'], ['free trial', 'saas']),
  'ppc_social_agency': ('white_label', 'PPC / social agencies', ['ppc', 'pay per click', 'google ads management', 'paid search', 'paid social',
     'social media marketing', 'social media management', 'facebook ads', 'meta ads', 'influencer marketing agency'], ['free trial', 'saas']),
  'branding_studio': ('white_label', 'Branding & design studios', ['branding agency', 'brand identity', 'branding studio', 'design studio', 'logo design',
     'brand strategy', 'graphic design studio', 'creative studio', 'graphic design services', 'graphic design',
     'branding services'],
    ['interior design', 'interior designer', 'architecture', 'architect', 'free trial', 'saas']),
  'web_agency': ('white_label', 'Web design agencies', ['web design agency', 'website design', 'web design', 'web development', 'website development',
     'wordpress agency', 'shopify agency', 'webflow agency', 'web designer', 'ecommerce development'], ['free trial', 'saas']),
  'it_msp': ('white_label', 'IT / MSP companies', ['managed it services', 'managed service provider', 'msp', 'it support', 'cybersecurity services',
     'it services', 'help desk', 'network support', 'it consulting', 'managed services'], []),
  'business_coach': ('white_label', 'Business coaches & consultancies', ['business coach', 'business coaching', 'business consulting', 'business mentor',
     'executive coaching', 'leadership coaching', 'small business consultant', 'strategy consulting', 'business consultant'], []),
  'print_sign': ('white_label', 'Print & sign shops', ['sign shop', 'signage', 'print shop', 'printing services', 'banners', 'vehicle wraps',
     'large format printing', 'screen printing', 'promotional products', 'business cards', 'embroidery',
     'custom embroidery'], []),
  # ---- C. Wellness & fitness ----
  'boutique_fitness': ('wellness', 'Boutique fitness studios', ['pilates', 'yoga studio', 'barre', 'spin studio', 'indoor cycling', 'hiit', 'bootcamp',
     'crossfit', 'fitness studio', 'reformer', 'class schedule', 'boxing gym', 'group fitness', 'yoga classes'], []),
  'recovery_studio': ('wellness', 'Recovery studios', ['infrared sauna', 'sauna', 'cold plunge', 'cryotherapy', 'float tank', 'floatation', 'float spa',
     'red light therapy', 'ice bath', 'recovery studio', 'compression therapy', 'iv therapy', 'contrast therapy'], []),
  'personal_training': ('wellness', 'Personal trainers & online coaching', ['personal trainer', 'personal training', 'online coaching', 'fitness coach',
     'strength coach', 'online personal training', 'fitness coaching', 'transformation program'], []),
  'wellness_retreat': ('wellness', 'Wellness retreats', ['wellness retreat', 'yoga retreat', 'meditation retreat', 'detox retreat', 'holistic retreat',
     'healing retreat'], ['church', 'parish', 'ministry']),
  'nutrition_coach': ('wellness', 'Nutrition coaches', ['nutritionist', 'nutrition coach', 'dietitian', 'dietician', 'nutrition coaching', 'meal plans',
     'holistic nutrition', 'weight loss coaching'], []),
  'physio_wellness': ('wellness', 'Physio-adjacent wellness', ['massage therapy', 'chiropractic', 'chiropractor', 'physiotherapy', 'physical therapy',
     'acupuncture', 'osteopathy', 'wellness center', 'wellness centre', 'naturopath', 'reiki', 'sports massage', 'holistic health'], []),
  # ---- D. Other ----
  'b2b_manufacturer': ('other', 'Independent B2B manufacturers & suppliers', ['manufacturer', 'manufacturing', 'industrial', 'oem', 'fabrication',
     'machining', 'cnc', 'wholesale supplier', 'distributor', 'industrial supplies', 'metal fabrication', 'injection molding', 'request a quote'], []),
  'specialty_contractor': ('other', 'Specialty contractors', ['cabinetry', 'countertops', 'flooring installation', 'solar installer', 'custom homes',
     'remodeling', 'remodelling', 'general contractor', 'kitchen remodel', 'decking', 'fencing contractor'], []),
  'boutique_hospitality': ('other', 'Boutique hotels, B&Bs, glamping', ['boutique hotel', 'bed and breakfast', 'b&b', 'glamping', 'guest house',
     'guesthouse', 'inn', 'cabin rentals', 'vacation rental', 'holiday cottage', 'eco lodge', 'farm stay'],
    ['prefab', 'travel agency', 'holiday packages']),
  'wineries_breweries': ('other', 'Wineries, breweries, distilleries', ['winery', 'vineyard', 'brewery', 'craft beer', 'brewing company', 'distillery',
     'cidery', 'meadery', 'taproom', 'wine club'], []),
  'course_creators': ('other', 'Course creators & creative education', ['online course', 'masterclass', 'e-course', 'enroll now', 'coaching program',
     'membership community', 'learn at your own pace', 'cohort'], []),
  'local_makers': ('other', 'Local makers', ['handmade', 'handcrafted', 'made by hand', 'small batch', 'ceramics', 'pottery', 'woodworking',
     'leather goods', 'etsy'], []),
  # ---- Saturated / excluded (recognised, not targeted) ----
  'dental': ('saturated', 'Dentists', ['dentist', 'dental', 'orthodontist', 'orthodontics', 'dental implants', 'teeth whitening'], []),
  'restaurant': ('saturated', 'Restaurants', ['restaurant', 'our menu', 'reservations', 'dine in', 'takeout', 'takeaway', 'bistro', 'pizzeria',
     'book a table', 'brunch'], []),
  'real_estate': ('saturated', 'Real estate agents', ['real estate', 'realtor', 'homes for sale', 'property listings', 'real estate agent', 'brokerage',
     'mls'], []),
  'law_firm': ('saturated', 'Law firms', ['law firm', 'attorney', 'lawyer', 'legal services', 'solicitors', 'personal injury'], []),
  'non_commercial': ('saturated', 'Non-profits, churches, schools, public bodies', ['non-profit', 'nonprofit', 'charity', 'church', 'parish', 'ministry',
     'school district', 'elementary school', 'city council', 'municipality', 'donate', 'scouts', 'scout group'], []),
}

# Booking / scheduling software (from the fingerprint data) that signals a wellness/fitness business.
BOOKING_TECH = ['MindBody', 'Glofox', 'Momence', 'Vagaro', 'Acuity Scheduling', 'Calendly', 'Fresha', 'Setmore', 'Zenoti', 'SimplyBook.me',
                'Arketa', 'Walla', 'Punchpass', 'TeamUp', 'Wodify']

def q(s): return "'" + s.replace("'", "''") + "'"

out = ["-- Phase 5: niche taxonomy (generated by packages/shared/seed/taxonomy.py). Editable in the dashboard.",
"""CREATE TABLE niches (
  id serial PRIMARY KEY, key text UNIQUE NOT NULL, name text NOT NULL,
  gate text NOT NULL DEFAULT 'none' CHECK (gate IN ('none', 'store', 'services', 'booking')),
  saturation_level text NOT NULL DEFAULT 'low' CHECK (saturation_level IN ('low', 'medium', 'high')),
  excluded boolean NOT NULL DEFAULT false, description text, enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE sub_niches (
  id serial PRIMARY KEY, niche_id integer NOT NULL REFERENCES niches(id) ON DELETE CASCADE,
  key text UNIQUE NOT NULL, name text NOT NULL, enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE keywords (
  id serial PRIMARY KEY, sub_niche_id integer NOT NULL REFERENCES sub_niches(id) ON DELETE CASCADE,
  term text NOT NULL, kind text NOT NULL DEFAULT 'positive' CHECK (kind IN ('positive', 'negative')),
  weight numeric NOT NULL DEFAULT 1, UNIQUE (sub_niche_id, term, kind)
);
CREATE TABLE url_patterns (
  id serial PRIMARY KEY, niche_id integer REFERENCES niches(id) ON DELETE CASCADE,
  sub_niche_id integer REFERENCES sub_niches(id) ON DELETE CASCADE,
  pattern text NOT NULL, weight numeric NOT NULL DEFAULT 1, note text
);
CREATE TABLE niche_tech_hints (
  id serial PRIMARY KEY, niche_id integer NOT NULL REFERENCES niches(id) ON DELETE CASCADE,
  tech text NOT NULL, weight numeric NOT NULL DEFAULT 3, UNIQUE (niche_id, tech)
);
CREATE TABLE classifications (
  domain_id bigint PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
  niche_id integer REFERENCES niches(id), sub_niche_id integer REFERENCES sub_niches(id),
  confidence numeric NOT NULL, score numeric NOT NULL, reason text, classified_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX classifications_niche_idx ON classifications (niche_id, sub_niche_id);
"""]
for k, (name, gate, sat, excl, desc) in GROUPS.items():
    out.append(f"INSERT INTO niches (key, name, gate, saturation_level, excluded, description) VALUES ({q(k)}, {q(name)}, {q(gate)}, {q(sat)}, {str(excl).lower()}, {q(desc)});")
for k, (g, name, pos, neg) in SUB.items():
    out.append(f"INSERT INTO sub_niches (niche_id, key, name) SELECT id, {q(k)}, {q(name)} FROM niches WHERE key = {q(g)};")
    for t in pos:
        out.append(f"INSERT INTO keywords (sub_niche_id, term, kind) SELECT id, {q(t)}, 'positive' FROM sub_niches WHERE key = {q(k)};")
    for t in neg:
        out.append(f"INSERT INTO keywords (sub_niche_id, term, kind, weight) SELECT id, {q(t)}, 'negative', 3 FROM sub_niches WHERE key = {q(k)};")
# URL path signals (regex on internal link paths)
URLS = [('white_label', r'^/(services|our-services)(/|$)', 1.5, 'Services section'), ('white_label', r'^/(case-studies|our-work|portfolio|work)(/|$)', 1.5, 'Portfolio'),
        ('white_label', r'^/(white-label|whitelabel|partners|partner-program|reseller)', 2, 'White-label / partner program'),
        ('wellness', r'^/(schedule|class-schedule|timetable|classes|book|booking|memberships?|pricing)(/|$)', 1.5, 'Classes / booking'),
        ('dtc', r'^/(products|collections|shop|product|product-category)/', 1, 'Store pages')]
for g, pat, w, note in URLS:
    out.append(f"INSERT INTO url_patterns (niche_id, pattern, weight, note) SELECT id, {q(pat)}, {w}, {q(note)} FROM niches WHERE key = {q(g)};")
for t in BOOKING_TECH:
    out.append(f"INSERT INTO niche_tech_hints (niche_id, tech, weight) SELECT id, {q(t)}, 3 FROM niches WHERE key = 'wellness';")
out.append("""INSERT INTO settings (key, value, description) VALUES
  ('classify.min_score', '4', 'Minimum keyword score for a niche match (below = out of scope)'),
  ('classify.field_weights', '{"title": 3, "h1": 2, "meta": 2, "site_name": 2, "products": 2, "text": 1, "domain": 1}', 'How much a keyword counts per page field'),
  ('stage.classify.batch_size', '2000', 'Pages per classification job'),
  ('stage.classify.snapshot_size', '20000', 'Pages planned at once for classification')
ON CONFLICT (key) DO NOTHING;""")
print('\n'.join(out))
