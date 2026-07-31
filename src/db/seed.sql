-- ====================================================================
-- YDECK AI AGENT — DEMO DATA SEED SCRIPT
-- ====================================================================

-- 1. Create Default Workspace
INSERT INTO workspaces (id, name, industry, default_language, working_hours)
VALUES (
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    'Tashkent Store Hub',
    'online_store',
    'uz',
    '{"start": "09:00", "end": "19:00", "days": [1,2,3,4,5,6]}'
) ON CONFLICT DO NOTHING;

-- 2. Insert Sample Multilingual Knowledge Base Items (Uzbek, Russian, English)
INSERT INTO knowledge_items (workspace_id, title, content, category, language, is_approved)
VALUES 
(
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    'Yetkazib berish shartlari',
    'Toshkent shahar ichida yetkazib berish narxi 20,000 so''m. 500,000 so''mdan yuqori buyurtmalar uchun yetkazib berish bepul.',
    'policy',
    'uz',
    true
),
(
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    'Условия доставки',
    'Доставка по Ташкенту стоит 20 000 сум. При заказе на сумму более 500 000 сум доставка бесплатная.',
    'policy',
    'ru',
    true
),
(
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    'Delivery Policy',
    'Delivery within Tashkent costs 20,000 UZS. Free delivery for orders over 500,000 UZS.',
    'policy',
    'en',
    true
) ON CONFLICT DO NOTHING;
