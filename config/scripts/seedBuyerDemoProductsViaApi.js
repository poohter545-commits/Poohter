require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const API_URL = process.env.POOHTER_API_URL || 'https://api.poohter.com/api';
const ADMIN_PASSWORD = process.env.POOHTER_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'admin123';

const demoProducts = [
  {
    name: 'Poohter Signature Hoodie',
    price: 49,
    stock: 45,
    description: 'Soft everyday hoodie with a clean premium fit for casual wear.',
  },
  {
    name: 'Urban Travel Backpack',
    price: 68,
    stock: 38,
    description: 'Durable multi-pocket backpack designed for school, office, and travel.',
  },
  {
    name: 'Minimal Desk Lamp',
    price: 35,
    stock: 52,
    description: 'Modern LED desk lamp with a compact profile and focused lighting.',
  },
  {
    name: 'Wireless Comfort Earbuds',
    price: 59,
    stock: 64,
    description: 'Lightweight wireless earbuds for calls, music, and everyday use.',
  },
  {
    name: 'Premium Stainless Bottle',
    price: 24,
    stock: 80,
    description: 'Insulated stainless bottle that keeps drinks cold or warm for hours.',
  },
  {
    name: 'Everyday Cotton Tee',
    price: 19,
    stock: 95,
    description: 'Breathable cotton tee with a smooth finish and relaxed fit.',
  },
  {
    name: 'Smart Fitness Band',
    price: 42,
    stock: 41,
    description: 'Simple activity tracker for steps, sleep, heart rate, and daily goals.',
  },
  {
    name: 'Home Organizer Set',
    price: 31,
    stock: 57,
    description: 'Stackable storage boxes for keeping daily essentials neat and visible.',
  },
];

const request = async (endpoint, { method = 'GET', token, body } = {}) => {
  const response = await fetch(`${API_URL}${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }

  if (!response.ok) {
    throw new Error(data.error || data.message || `${method} ${endpoint} failed with ${response.status}`);
  }

  return data;
};

const run = async () => {
  const login = await request('/admin/login', {
    method: 'POST',
    body: { password: ADMIN_PASSWORD },
  });
  const token = login.token;

  const allProducts = await request('/admin/products', { token });
  const existingByName = new Map(allProducts.map((product) => [String(product.name).toLowerCase(), product]));
  const results = [];

  for (const product of demoProducts) {
    let action = 'updated';
    let current = existingByName.get(product.name.toLowerCase());

    if (!current) {
      const created = await request('/products', {
        method: 'POST',
        body: {
          name: product.name,
          price: product.price,
          description: product.description,
        },
      });
      current = created.product;
      action = 'inserted';
    }

    await request(`/admin/products/${current.id}/status`, {
      method: 'PATCH',
      token,
      body: { status: 'live' },
    });

    await request(`/admin/products/${current.id}/stock`, {
      method: 'PATCH',
      token,
      body: { stock: product.stock },
    });

    results.push({
      id: current.id,
      name: product.name,
      price: product.price,
      stock: product.stock,
      status: 'live',
      action,
    });
  }

  console.log(JSON.stringify({ api: API_URL, products: results }, null, 2));
};

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
