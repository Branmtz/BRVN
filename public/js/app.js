// Global State
let allProducts = [];
let filteredProducts = [];
let currentGenderFilter = 'all';
let currentCategoryFilter = 'all';
let currentBrandFilter = 'all';
let currentTab = 'home';
let currentSelectedCategory = null; // Can be 'Mujeres', 'Hombres', 'Niños', 'Lo más vendido'
let categoryBrandFilter = 'all';

// Infinite scroll state
const PAGE_SIZE = 24;
let currentPage = 0;
let isLoadingMore = false;
let scrollObserver = null;

// Product detail page state
let selectedSize = null;
let currentProduct = null;
let currentImageIdx = 0;
let selectedShippingRate = null;
window.appliedCouponCode = null;
window.appliedDiscountPercent = 0;

// Hero Carousel State
let currentCarouselSlideIdx = 0;
let carouselTimer = null;

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
  updateCartCount();
  initAnnouncementBanner();
  
  // Route check
  const path = window.location.pathname;
  if (path === '/' || path.includes('index.html') || path === '') {
    initCatalogPage();
  } else if (path.includes('product.html')) {
    initProductDetailPage();
  } else if (path.includes('cart.html')) {
    initCartPage();
  }
});

// Rotating Announcement Banner
function initAnnouncementBanner() {
  const announcements = [
    "🎁 ¡Regalo en tu Primera Compra, ¡Regístrate ahora! 🎁",
    "💳 Compra a MSI con Mercado Pago"
  ];
  const textEl = document.getElementById('announcement-text');
  if (!textEl) return;
  
  let index = 0;
  setInterval(() => {
    textEl.style.opacity = 0;
    setTimeout(() => {
      index = (index + 1) % announcements.length;
      textEl.textContent = announcements[index];
      textEl.style.opacity = 1;
    }, 500); // match transition duration
  }, 4000);
}

// Update cart counter in header
function updateCartCount() {
  const cart = JSON.parse(localStorage.getItem('paps_cart') || '[]');
  const totalQty = cart.reduce((sum, item) => sum + item.qty, 0);
  
  // Update desktop cart count
  const countEl = document.getElementById('cart-count');
  if (countEl) countEl.textContent = totalQty;
  
  // Update mobile bottom nav cart count
  const mobileCountEl = document.getElementById('mobile-cart-badge');
  if (mobileCountEl) mobileCountEl.textContent = totalQty;
}

// Auth Helper Functions
function getAuthToken() {
  return localStorage.getItem('paps_customer_token');
}

function setAuthToken(token) {
  if (token) {
    localStorage.setItem('paps_customer_token', token);
  } else {
    localStorage.removeItem('paps_customer_token');
  }
}

function fetchWithAuth(url, options = {}) {
  const token = getAuthToken();
  if (token) {
    options.headers = {
      ...options.headers,
      'Authorization': `Bearer ${token}`
    };
  }
  return fetch(url, options);
}

// Star rating icon drawing helper
function renderStarIcons(average) {
  let starsHtml = '';
  const rounded = Math.round(average || 0);
  for (let i = 1; i <= 5; i++) {
    if (i <= rounded) {
      starsHtml += '<i class="fa-solid fa-star"></i>';
    } else {
      starsHtml += '<i class="fa-regular fa-star"></i>';
    }
  }
  return starsHtml;
}

/* --- Catalog Page Logic --- */
async function initCatalogPage() {
  const gridEl = document.getElementById('category-product-grid');
  
  const params = new URLSearchParams(window.location.search);
  const tabParam = params.get('tab');
  const categoryParam = params.get('category');
  const searchParam = params.get('search');
  
  try {
    // 1. Fetch catalog products (first page only)
    const res = await fetchWithAuth('/api/products?limit=24&page=0');
    if (!res.ok) throw new Error('Failed to fetch catalog');
    const data = await res.json();
    allProducts = Array.isArray(data) ? data : (data.products || []);
    
    // 2. Route parameters handling
    if (searchParam) {
      executeGlobalSearch(searchParam);
    } else if (categoryParam) {
      selectCategory(categoryParam);
    } else if (tabParam === 'trends') {
      selectCategory('Lo más vendido');
    } else if (tabParam && tabParam !== 'home') {
      switchTab(tabParam);
    } else {
      showMainLanding();
    }
  } catch (err) {
    console.error(err);
    if (gridEl) {
      gridEl.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; padding: 48px; color: #ff3b30;">
          <i class="fa-solid fa-circle-exclamation" style="font-size: 24px; margin-bottom: 12px;"></i>
          <p>Error al cargar el catálogo. Por favor, intente de nuevo más tarde.</p>
        </div>
      `;
    }
  }
}

function renderProducts() {
  const gridEl = document.getElementById('product-grid');
  if (!gridEl) return;

  // Reset scroll state on every full re-render (filter change)
  currentPage = 0;
  isLoadingMore = false;

  // Remove existing sentinel if any
  const oldSentinel = document.getElementById('scroll-sentinel');
  if (oldSentinel) oldSentinel.remove();
  if (scrollObserver) { scrollObserver.disconnect(); scrollObserver = null; }

  if (filteredProducts.length === 0) {
    gridEl.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 48px; color: var(--text-secondary);">
        <p>No se encontraron calzados que coincidan con tu búsqueda.</p>
      </div>
    `;
    return;
  }

  // Render first batch
  if (window.innerWidth <= 768) {
    gridEl.innerHTML = `
      <div class="masonry-column masonry-column-left"></div>
      <div class="masonry-column masonry-column-right"></div>
    `;
  } else {
    gridEl.innerHTML = '';
  }
  appendProductBatch();
}

function buildProductCard(p, imgClass = '') {
  const mainImg = p.images && p.images.length > 0 ? p.images[0] : '/placeholder.jpg';
  const heartActive = p.isFavorite ? 'active' : '';
  const heartIcon = p.isFavorite ? 'fa-solid' : 'fa-regular';
  
  const isPicafresa = p.title && p.title.toLowerCase().includes('picafresa');
  const originText = (isPicafresa && p.origin === 'PAPS') ? 'Dulce' : (p.origin === 'PAPS' ? 'PAPS' : 'Importado');
  const brandText = (isPicafresa && p.brand === 'PAPS') ? 'Dulce' : (p.brand || 'Calzado');
  
  return `
    <article class="product-card" onclick="window.location.href='/product.html?id=${p.id}'">
      <button class="favorite-btn ${heartActive}" onclick="toggleFavorite(event, '${p.id}')" title="Guardar en favoritos">
        <i class="${heartIcon} fa-heart"></i>
      </button>
      <span class="origin-tag ${p.origin}">
        ${originText}
      </span>
      ${(p.is_bestseller === 1 || p.is_bestseller === true || p.is_bestseller === '1') ? `
      <span class="bestseller-tag">
        <i class="fa-solid fa-fire"></i> Más Vendido
      </span>
      ` : ''}
      <div class="product-image-container ${imgClass}">
        <img src="${mainImg}" alt="${p.title}" loading="lazy">
      </div>
      <div class="product-info">
        <span class="product-brand">${brandText}</span>
        <h3 class="product-title">${p.title}</h3>
        <div class="product-meta">
          <span class="product-price">$${p.price.toLocaleString()} MXN</span>
          <a href="/product.html?id=${p.id}" class="view-btn">Ver</a>
        </div>
      </div>
    </article>
  `;
}

function appendProductBatch() {
  const gridEl = document.getElementById('product-grid');
  if (!gridEl) return;

  const start = currentPage * PAGE_SIZE;
  const end   = start + PAGE_SIZE;
  const batch = filteredProducts.slice(start, end);

  if (batch.length === 0) return;

  const oldSentinel = document.getElementById('scroll-sentinel');
  if (oldSentinel) oldSentinel.remove();

  const leftCol = gridEl.querySelector('.masonry-column-left');
  const rightCol = gridEl.querySelector('.masonry-column-right');
  if (leftCol && rightCol && window.innerWidth <= 768) {
    batch.forEach((p, idx) => {
      const globalIdx = start + idx;
      // Tall, Short, Short, Tall pattern
      const imgClass = (globalIdx % 4 === 0 || globalIdx % 4 === 3) ? 'tall' : 'short';
      const cardHtml = buildProductCard(p, imgClass);
      if (globalIdx % 2 === 0) {
        leftCol.insertAdjacentHTML('beforeend', cardHtml);
      } else {
        rightCol.insertAdjacentHTML('beforeend', cardHtml);
      }
    });
  } else {
    batch.forEach(p => {
      gridEl.insertAdjacentHTML('beforeend', buildProductCard(p));
    });
  }

  currentPage++;

  if (currentPage * PAGE_SIZE < filteredProducts.length) {
    const sentinel = document.createElement('div');
    sentinel.id = 'scroll-sentinel';
    sentinel.style.cssText = 'grid-column:1/-1; height:60px; display:flex; align-items:center; justify-content:center;';
    sentinel.innerHTML = '<span style="font-size:12px;color:#aaa;letter-spacing:0.05em;">Cargando más...</span>';
    gridEl.appendChild(sentinel);

    if (scrollObserver) scrollObserver.disconnect();
    scrollObserver = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !isLoadingMore) {
        isLoadingMore = true;
        setTimeout(() => {
          appendProductBatch();
          isLoadingMore = false;
        }, 120);
      }
    }, { rootMargin: '200px' });

    scrollObserver.observe(sentinel);
  }
}

function renderProductListToGrid(products, gridEl) {
  if (!gridEl) return;

  if (products.length === 0) {
    gridEl.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 48px; color: var(--text-secondary);">
        <p>No hay productos disponibles.</p>
      </div>
    `;
    return;
  }

  if (window.innerWidth <= 768) {
    // Mobile: Render as two columns (left and right) for true masonry stagger
    let leftHtml = '';
    let rightHtml = '';
    products.forEach((p, idx) => {
      // Tall, Short, Short, Tall pattern
      const imgClass = (idx % 4 === 0 || idx % 4 === 3) ? 'tall' : 'short';
      const cardHtml = buildProductCard(p, imgClass);
      if (idx % 2 === 0) {
        leftHtml += cardHtml;
      } else {
        rightHtml += cardHtml;
      }
    });
    gridEl.innerHTML = `
      <div class="masonry-column masonry-column-left"></div>
      <div class="masonry-column masonry-column-right"></div>
    `;
    gridEl.querySelector('.masonry-column-left').innerHTML = leftHtml;
    gridEl.querySelector('.masonry-column-right').innerHTML = rightHtml;
  } else {
    // Desktop: Render flat list
    gridEl.innerHTML = products.map(p => buildProductCard(p)).join('');
  }
}

// Helpers to get active filter elements (mobile or desktop)
function getSearchInput() {
  const mob = document.getElementById('mobile-search-input');
  const desk = document.getElementById('search-input');
  if (mob && window.innerWidth <= 768) return mob;
  return desk;
}

// Search products by title or brand
window.searchProducts = function() {
  const input = getSearchInput();
  const query = input ? input.value.toLowerCase().trim() : '';
  applyFilters(query, currentGenderFilter, currentCategoryFilter, currentBrandFilter);
};
window.searchProductsMobile = window.searchProducts;

// Filter by Gender
window.filterByGender = function(gender) {
  currentGenderFilter = gender;
  
  const selectEl = document.getElementById('gender-select');
  if (selectEl) selectEl.value = gender;
  const selectElMobile = document.getElementById('mobile-gender-select');
  if (selectElMobile) selectElMobile.value = gender;
  
  currentCategoryFilter = 'all';
  const catSelectEl = document.getElementById('category-select');
  if (catSelectEl) catSelectEl.value = 'all';
  const catSelectElMobile = document.getElementById('mobile-category-select');
  if (catSelectElMobile) catSelectElMobile.value = 'all';
  
  loadCategoryFilters();
  
  const input = getSearchInput();
  const searchQuery = input ? input.value.toLowerCase().trim() : '';
  applyFilters(searchQuery, gender, currentCategoryFilter, currentBrandFilter);
};
window.filterByGenderMobile = window.filterByGender;

// Filter by Category
window.filterByCategory = function(category) {
  currentCategoryFilter = category;
  
  const selectEl = document.getElementById('category-select');
  if (selectEl) selectEl.value = category;
  const selectElMobile = document.getElementById('mobile-category-select');
  if (selectElMobile) selectElMobile.value = category;
  
  const input = getSearchInput();
  const searchQuery = input ? input.value.toLowerCase().trim() : '';
  applyFilters(searchQuery, currentGenderFilter, category, currentBrandFilter);
};
window.filterByCategoryMobile = window.filterByCategory;

// Filter by Brand
window.filterByBrand = function(brand) {
  currentBrandFilter = brand;
  
  const selectEl = document.getElementById('brand-select');
  if (selectEl) selectEl.value = brand;
  const selectElMobile = document.getElementById('mobile-brand-select');
  if (selectElMobile) selectElMobile.value = brand;
  
  const input = getSearchInput();
  const searchQuery = input ? input.value.toLowerCase().trim() : '';
  applyFilters(searchQuery, currentGenderFilter, currentCategoryFilter, brand);
};
window.filterByBrandMobile = window.filterByBrand;

function applyFilters(searchQuery, gender, category, brand) {
  filteredProducts = allProducts.filter(p => {
    const matchesSearch = p.title.toLowerCase().includes(searchQuery) || 
                          (p.description && p.description.toLowerCase().includes(searchQuery)) ||
                          (p.brand && p.brand.toLowerCase().includes(searchQuery)) ||
                          (p.sku && p.sku.toLowerCase().includes(searchQuery)) ||
                          (p.id && String(p.id).toLowerCase().includes(searchQuery));
    const matchesGender = gender === 'all' || p.gender === gender;
    const matchesCategory = category === 'all' || p.category === category;
    const matchesBrand = brand === 'all' || p.brand === brand;
    return matchesSearch && matchesGender && matchesCategory && matchesBrand;
  });
  renderProducts();
}

/* --- SPA Tab Switcher (Mobile & Cross-page) --- */
window.switchTab = function(tabName) {
  // If not on index.html, redirect back to index.html with tab param
  const path = window.location.pathname;
  const isIndex = path === '/' || path.includes('index.html') || path === '';
  
  if (!isIndex) {
    window.location.href = `/index.html?tab=${tabName}`;
    return;
  }
  
  if (tabName === 'home') {
    currentTab = 'home';
    showMainLanding();
  } else if (tabName === 'categories') {
    currentTab = 'home'; // Show home view and scroll to categories
    showMainLanding();
    setTimeout(() => {
      const target = document.getElementById('categories-section-anchor');
      if (target) target.scrollIntoView({ behavior: 'smooth' });
    }, 100);
    tabName = 'home'; // Map tab display active states to home
  } else if (tabName === 'trends') {
    currentTab = 'home';
    showMainLanding();
    selectCategory('Lo más vendido');
    tabName = 'home'; // Map active nav state to home since it's inside home
  } else {
    currentTab = tabName;
  }
  
  const tabs = ['home', 'categories', 'trends', 'menu'];
  tabs.forEach(tab => {
    const section = document.getElementById(`${tab}-view`);
    if (section) section.classList.remove('active');
    
    const navBtn = document.getElementById(`bottom-nav-${tab}`);
    if (navBtn) navBtn.classList.remove('active');
  });
  
  // Mapped tabName might be home if categories/trends mapped to home
  const activeSection = document.getElementById(`${tabName}-view`);
  if (activeSection) activeSection.classList.add('active');
  
  const activeNavBtn = document.getElementById(`bottom-nav-${tabName}`);
  if (activeNavBtn) activeNavBtn.classList.add('active');
  
  // Toggle mobile top filters display
  const mobileBar = document.querySelector('.mobile-search-filters');
  if (mobileBar) {
    if (tabName === 'home' && !currentSelectedCategory) {
      mobileBar.classList.remove('hidden');
    } else {
      mobileBar.classList.add('hidden');
    }
  }
  
  // Tab-specific views rendering
  if (tabName === 'menu') {
    if (getAuthToken()) {
      showDashboard();
    } else {
      showAuth();
    }
  }
};

/* --- Product Detail Page Logic --- */
async function initProductDetailPage() {
  const params = new URLSearchParams(window.location.search);
  const productId = params.get('id');
  
  if (!productId) {
    window.location.href = '/';
    return;
  }
  
  try {
    const res = await fetchWithAuth(`/api/products/${productId}`);
    if (!res.ok) throw new Error('Product not found');
    currentProduct = await res.json();
    renderProductDetail();
    
    // Trigger non-blocking live stock sync in the background
    if (currentProduct && currentProduct.origin === 'priceshoes') {
      triggerBackgroundStockSync(currentProduct.id);
    }
  } catch (err) {
    console.error(err);
    document.getElementById('detail-page-content').innerHTML = `
      <div style="text-align: center; padding: 64px 0; color: #ff3b30;">
        <i class="fa-solid fa-triangle-exclamation" style="font-size: 32px; margin-bottom: 16px;"></i>
        <h2>Producto no encontrado</h2>
        <p style="color: var(--text-secondary); margin-top: 8px;">El calzado seleccionado no existe o no se encuentra activo.</p>
        <a href="/" class="view-btn" style="display: inline-block; margin-top: 24px;">Volver al catálogo</a>
      </div>
    `;
  }
}

function renderProductDetail() {
  const p = currentProduct;
  const mainImageContainer = document.getElementById('main-image-view');
  const thumbnailsGrid = document.getElementById('thumbnails-grid');
  const isPicafresa = p.title && p.title.toLowerCase().includes('picafresa');
  
  // Set basic info
  document.getElementById('detail-brand').textContent = isPicafresa ? 'DULCE' : (p.brand || 'Calzado');
  document.getElementById('detail-title').textContent = p.title;
  document.getElementById('detail-price').textContent = `$${p.price.toLocaleString()} MXN`;
  
  // Do not show rating stars on product details
  const ratingEl = document.getElementById('detail-rating');
  if (ratingEl) {
    ratingEl.remove();
  }
  
  let specsHtml = '';
  if (p.specifications) {
    try {
      const specs = typeof p.specifications === 'string' ? JSON.parse(p.specifications) : p.specifications;
      const specItems = [];
      if (specs.Marca) specItems.push(`<li><strong>Marca:</strong> ${specs.Marca}</li>`);
      if (specs.Modelo) specItems.push(`<li><strong>Modelo:</strong> ${specs.Modelo}</li>`);
      if (specs.Material) specItems.push(`<li><strong>Material:</strong> ${specs.Material}</li>`);
      if (specs.Color) specItems.push(`<li><strong>Color:</strong> ${specs.Color}</li>`);
      if (specs.Subcategoría) specItems.push(`<li><strong>Subcategoría:</strong> ${specs.Subcategoría}</li>`);
      if (specs.Acabado) specItems.push(`<li><strong>Acabado/Distintivo:</strong> ${specs.Acabado}</li>`);
      if (specs.Género) specItems.push(`<li><strong>Género:</strong> ${specs.Género}</li>`);
      
      if (specItems.length > 0) {
        specsHtml = `
          <div class="technical-specs" style="margin-top: 20px; border-top: 1px dashed #ddd; padding-top: 15px;">
            <h4 style="margin-bottom: 10px; font-weight: bold; font-size: 14px; color: var(--text-primary);">Especificaciones Técnicas</h4>
            <ul style="list-style-type: disc; padding-left: 20px; color: var(--text-secondary); line-height: 1.6; font-size: 13px;">
              ${specItems.join('')}
            </ul>
          </div>
        `;
      }
    } catch (e) {
      console.error('Error parsing specifications:', e);
    }
  }

  document.getElementById('detail-desc').innerHTML = `
    <p>${p.description || 'Sin descripción detallada.'}</p>
    <p style="margin-top: 12px;"><strong>Color:</strong> ${p.color || 'Único'}</p>
    <p style="margin-top: 6px;"><strong>Modelo SKU:</strong> ${p.sku}</p>
    <p style="margin-top: 6px;"><strong>Origen:</strong> ${p.origin === 'PAPS' ? 'PAPS Stock Local' : 'Importación'}</p>
    ${specsHtml}
  `;
  
  // Render Main Image with Favorite Button overlay and Navigation Arrows
  currentImageIdx = 0; // reset index on product render
  const mainImgUrl = p.images && p.images.length > 0 ? p.images[0] : '/placeholder.jpg';
  if (mainImageContainer) {
    mainImageContainer.style.position = 'relative';
    const heartActive = p.isFavorite ? 'active' : '';
    const heartIcon = p.isFavorite ? 'fa-solid' : 'fa-regular';
    
    // Check if we need navigation arrows (more than 1 image)
    const hasMultipleImages = p.images && p.images.length > 1;
    const arrowStyles = `
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      background-color: rgba(255, 255, 255, 0.9);
      border: 1px solid var(--border-color, #e5e5e5);
      border-radius: 50%;
      width: 40px;
      height: 40px;
      display: ${hasMultipleImages ? 'flex' : 'none'};
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 16px;
      color: var(--text-primary, #1d1d1f);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
      z-index: 10;
    `;
    
    mainImageContainer.innerHTML = `
      <img src="${mainImgUrl}" id="expanded-image" alt="${p.title}">
      <button class="favorite-btn ${heartActive}" onclick="toggleFavorite(event, '${p.id}')" style="top: 24px; right: 24px;" title="Guardar en favoritos">
        <i class="${heartIcon} fa-heart"></i>
      </button>
      
      <!-- Navigation Arrows -->
      <button id="prev-image-btn" onclick="prevProductImage()" style="${arrowStyles} left: 16px;" class="image-nav-arrow" title="Imagen anterior">
        <i class="fa-solid fa-chevron-left"></i>
      </button>
      <button id="next-image-btn" onclick="nextProductImage()" style="${arrowStyles} right: 16px;" class="image-nav-arrow" title="Siguiente imagen">
        <i class="fa-solid fa-chevron-right"></i>
      </button>
    `;
  }
  
  // Render Thumbnails
  if (thumbnailsGrid && p.images && p.images.length > 1) {
    thumbnailsGrid.innerHTML = p.images.map((img, idx) => `
      <div class="thumbnail-card ${idx === 0 ? 'active' : ''}" onclick="switchImage(this, '${img}')">
        <img src="${img}" alt="Miniatura ${idx + 1}">
      </div>
    `).join('');
  } else if (thumbnailsGrid) {
    thumbnailsGrid.innerHTML = '';
  }
  
  // Cambiar título de sección solo para Picafresa
  const detailSectionTitles = document.querySelectorAll('.detail-section-title');
  detailSectionTitles.forEach(el => {
    if (el.textContent.trim().toLowerCase().includes('detalles del calzado')) {
      el.textContent = isPicafresa ? 'Detalles del Producto' : 'Detalles del Calzado';
    }
  });

  // Render Sizes Selector
  const sizeSelector = document.getElementById('size-selector');
  const sizeSection = sizeSelector ? sizeSelector.closest('div').parentElement : null;
  const stockIndicator = document.getElementById('size-stock-indicator');
  if (stockIndicator) {
    stockIndicator.innerHTML = '';
  }

  // Ocultar selector de tallas para Picafresa
  if (isPicafresa) {
    if (sizeSection) sizeSection.style.display = 'none';
    if (stockIndicator) stockIndicator.style.display = 'none';
  } else {
    if (sizeSection) sizeSection.style.display = '';
    if (stockIndicator) stockIndicator.style.display = '';
  }

  if (!isPicafresa && sizeSelector) {
    if (p.sizes && p.sizes.length > 0) {
      // Deduplicate sizes to avoid duplicate selection pills
      const uniqueSizes = Array.from(new Set(p.sizes));
      // Sort sizes from smallest to largest (ascending)
      const sortedSizes = uniqueSizes.sort((a, b) => {
        const numA = parseFloat(a);
        const numB = parseFloat(b);
        if (isNaN(numA) && isNaN(numB)) {
          return a.toString().localeCompare(b.toString());
        }
        if (isNaN(numA)) return 1;
        if (isNaN(numB)) return -1;
        return numA - numB;
      });

      sizeSelector.innerHTML = sortedSizes.map(size => `
        <button class="size-pill" onclick="selectSize(this, '${size}')">${size}</button>
      `).join('');
      
      // Auto-select the first size pill to show the stock validation immediately on load
      const firstPill = sizeSelector.querySelector('.size-pill');
      if (firstPill) {
        firstPill.click();
      }
    } else {
      sizeSelector.innerHTML = '<p style="color: #ff3b30;">Agotado temporalmente en todas las tallas.</p>';
      const buyBtn = document.getElementById('buy-btn');
      if (buyBtn) buyBtn.disabled = true;
    }
  }
}

window.switchImage = function(cardEl, imgUrl) {
  document.getElementById('expanded-image').src = imgUrl;
  const cards = document.querySelectorAll('.thumbnail-card');
  cards.forEach((c, idx) => {
    c.classList.remove('active');
    if (c === cardEl) {
      currentImageIdx = idx;
      c.classList.add('active');
    }
  });
};

window.prevProductImage = function() {
  if (!currentProduct || !currentProduct.images || currentProduct.images.length <= 1) return;
  currentImageIdx = (currentImageIdx - 1 + currentProduct.images.length) % currentProduct.images.length;
  updateProductImageFromIndex();
};

window.nextProductImage = function() {
  if (!currentProduct || !currentProduct.images || currentProduct.images.length <= 1) return;
  currentImageIdx = (currentImageIdx + 1) % currentProduct.images.length;
  updateProductImageFromIndex();
};

function updateProductImageFromIndex() {
  const imgUrl = currentProduct.images[currentImageIdx];
  const expandedImg = document.getElementById('expanded-image');
  if (expandedImg) {
    expandedImg.src = imgUrl;
  }
  
  // Update thumbnail active states
  const cards = document.querySelectorAll('.thumbnail-card');
  cards.forEach((c, idx) => {
    if (idx === currentImageIdx) {
      c.classList.add('active');
      c.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    } else {
      c.classList.remove('active');
    }
  });
}

window.selectSize = function(pillEl, size) {
  selectedSize = size;
  const pills = document.querySelectorAll('.size-pill');
  pills.forEach(p => p.classList.remove('active'));
  pillEl.classList.add('active');
  
  // Update stock indicator below size buttons
  const stockIndicator = document.getElementById('size-stock-indicator');
  if (stockIndicator && currentProduct) {
    const stockMap = currentProduct.sizes_stock || {};
    let qty = 99; // Default fallback for local products without scraper metadata
    
    // Attempt to match size keys (handling potential floats like "23.0" or "23")
    const sizeStr = size.toString().trim();
    if (stockMap && typeof stockMap === 'object') {
      if (sizeStr in stockMap) {
        qty = parseInt(stockMap[sizeStr]) || 0;
      } else if (`${sizeStr}.0` in stockMap) {
        qty = parseInt(stockMap[`${sizeStr}.0`]) || 0;
      } else {
        const floatKey = parseFloat(sizeStr);
        for (const k in stockMap) {
          if (parseFloat(k) === floatKey) {
            qty = parseInt(stockMap[k]) || 0;
            break;
          }
        }
      }
    }
    
    if (qty >= 5) {
      stockIndicator.style.color = '#34c759'; // Green
      stockIndicator.innerHTML = `<i class="fa-solid fa-circle-check"></i> ${qty} pares disponibles`;
    } else {
      stockIndicator.style.color = '#ff3b30'; // Red
      stockIndicator.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${qty} pares disponibles <span style="font-weight: 600; color: #ff3b30; display: block; margin-top: 4px; font-size: 13px;">⚠️ Requiere verificación de stock</span>`;
    }
  }
};

// Add to Cart
window.addToCart = function() {
  if (!currentProduct) return;
  
  const isPicafresa = currentProduct.title && currentProduct.title.toLowerCase().includes('picafresa');
  
  if (!selectedSize && !isPicafresa) {
    alert('Por favor, selecciona una talla antes de continuar.');
    return;
  }
  
  const cart = JSON.parse(localStorage.getItem('paps_cart') || '[]');
  
  // Check if item with same ID and size exists
  const existingIdx = cart.findIndex(item => item.id === currentProduct.id && item.size === selectedSize);
  
  if (existingIdx > -1) {
    cart[existingIdx].qty += 1;
  } else {
    const mainImg = currentProduct.images && currentProduct.images.length > 0 ? currentProduct.images[0] : '/placeholder.jpg';
    cart.push({
      id: currentProduct.id,
      sku: currentProduct.sku,
      title: currentProduct.title,
      size: selectedSize || 'Único',
      color: currentProduct.color,
      price: currentProduct.price,
      image: mainImg,
      qty: 1
    });
  }
  
  localStorage.setItem('paps_cart', JSON.stringify(cart));
  updateCartCount();
  
  // Redirect to shopping cart
  window.location.href = '/cart.html';
};

function triggerBackgroundStockSync(productId) {
  // Show a small verification loader in the stock indicator area
  const stockIndicator = document.getElementById('size-stock-indicator');
  if (stockIndicator) {
    stockIndicator.style.color = 'var(--text-secondary)';
    stockIndicator.innerHTML = `
      <div style="margin-top: 10px; max-width: 280px; font-family: inherit;">
        <div style="font-size: 13px; font-weight: 500; color: var(--text-secondary); margin-bottom: 6px; display: flex; align-items: center; gap: 8px;">
          <i class="fa-solid fa-circle-notch fa-spin" style="color: #ff9500;"></i> Verificando stock físico en tiempo real
        </div>
        <div style="width: 100%; height: 4px; background: #e5e5ea; border-radius: 2px; overflow: hidden; position: relative;">
          <div style="position: absolute; width: 35%; height: 100%; background: linear-gradient(90deg, #ff9500, #ff3b30); border-radius: 2px; animation: shimmerBar 1.4s infinite ease-in-out;"></div>
        </div>
        <style>
          @keyframes shimmerBar {
            0% { left: -35%; }
            50% { left: 50%; }
            100% { left: 100%; }
          }
        </style>
      </div>
    `;
  }
  
  fetchWithAuth(`/api/products/${productId}/sync`)
    .then(res => {
      if (!res.ok) throw new Error('Sync failed');
      return res.json();
    })
    .then(data => {
      if (currentProduct && currentProduct.id === productId) {
        // Update product data
        currentProduct.sizes = data.sizes;
        currentProduct.sizes_stock = data.sizes_stock;
        currentProduct.stock = data.stock;
        
        // Re-render size pills with new sorted sizes
        const prevSelectedSize = selectedSize;
        renderProductDetail();
        
        // Keep previous selection active, or fallback to first pill
        if (prevSelectedSize) {
          const sizeSelector = document.getElementById('size-selector');
          if (sizeSelector) {
            const pills = sizeSelector.querySelectorAll('.size-pill');
            let matched = false;
            for (const pill of pills) {
              if (pill.textContent.trim() === prevSelectedSize.toString().trim()) {
                pill.click();
                matched = true;
                break;
              }
            }
            // If previous selected size is no longer available in the new sync
            if (!matched && pills.length > 0) {
              pills[0].click();
            }
          }
        }
      }
    })
    .catch(err => {
      console.error('[Background Sync Error]:', err);
      // Restore cached state display if there was a selection
      if (selectedSize) {
        const sizeSelector = document.getElementById('size-selector');
        if (sizeSelector) {
          const pills = sizeSelector.querySelectorAll('.size-pill');
          for (const pill of pills) {
            if (pill.classList.contains('active')) {
              selectSize(pill, selectedSize);
              break;
            }
          }
        }
      } else {
        const stockIndicator = document.getElementById('size-stock-indicator');
        if (stockIndicator) {
          stockIndicator.innerHTML = '';
        }
      }
    });
}

/* --- Favorites Toggle Logic --- */
window.toggleFavorite = async function(event, productId) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  
  if (!getAuthToken()) {
    alert('Por favor, inicia sesión para guardar este calzado en tus favoritos.');
    switchTab('menu');
    return;
  }
  
  try {
    const res = await fetchWithAuth('/api/customer/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId })
    });
    
    if (res.ok) {
      const data = await res.json();
      
      // Update heart button icons dynamically in the DOM
      const heartBtns = document.querySelectorAll(`[onclick*="toggleFavorite(event, '${productId}')"]`);
      heartBtns.forEach(btn => {
        if (data.saved) {
          btn.classList.add('active');
          btn.querySelector('i').className = 'fa-solid fa-heart';
        } else {
          btn.classList.remove('active');
          btn.querySelector('i').className = 'fa-regular fa-heart';
        }
      });
      
      // Update in local array
      const pIndex = allProducts.findIndex(p => p.id === productId);
      if (pIndex !== -1) {
        allProducts[pIndex].isFavorite = data.saved;
      }
      if (currentProduct && currentProduct.id === productId) {
        currentProduct.isFavorite = data.saved;
      }
      
      // Refresh dashboard favorites tab if active
      const favsTab = document.getElementById('db-tab-favorites');
      if (favsTab && favsTab.classList.contains('active')) {
        loadDashboardFavorites();
      }
    }
  } catch (err) {
    console.error('Error toggling favorite:', err);
  }
};

/* --- Cart Page Logic --- */
function initCartPage() {
  window.appliedCouponCode = null;
  window.appliedDiscountPercent = 0;

  renderCart();
  checkAndPrefillCartForm();
  
  const checkoutForm = document.getElementById('checkout-form');
  if (checkoutForm) {
    checkoutForm.addEventListener('submit', handleCheckoutSubmit);
  }

  const applyBtn = document.getElementById('apply-coupon-btn');
  if (applyBtn) {
    applyBtn.addEventListener('click', window.applyCoupon);
  }

  const zipInput = document.getElementById('client-zip');
  if (zipInput) {
    const checkZip = () => {
      const zip = zipInput.value.trim();
      if (/^\d{5}$/.test(zip)) {
        fetchShippingQuotes(zip);
      }
    };
    zipInput.addEventListener('input', (e) => {
      const zip = e.target.value.trim();
      if (/^\d{5}$/.test(zip)) {
        fetchShippingQuotes(zip);
      } else {
        const wrapper = document.getElementById('shipping-methods-wrapper');
        if (wrapper) wrapper.style.display = 'none';
        resetShippingChoice();
      }
    });
    setTimeout(checkZip, 500);
  }
}

function renderCart() {
  const itemsContainer = document.getElementById('cart-items-list');
  const cart = JSON.parse(localStorage.getItem('paps_cart') || '[]');
  
  if (!itemsContainer) return;
  
  if (cart.length === 0) {
    itemsContainer.innerHTML = `
      <div style="text-align: center; padding: 48px 0; color: var(--text-secondary);">
        <i class="fa-solid fa-bag-shopping" style="font-size: 36px; margin-bottom: 16px;"></i>
        <p>Tu carrito está vacío.</p>
        <a href="/" class="view-btn" style="display: inline-block; margin-top: 16px;">Ir a comprar</a>
      </div>
    `;
    const summaryBox = document.getElementById('checkout-box');
    if (summaryBox) summaryBox.style.display = 'none';
    return;
  }
  
  // Render Items list
  itemsContainer.innerHTML = cart.map((item, idx) => `
    <div class="cart-item">
      <div class="cart-item-img">
        <img src="${item.image}" alt="${item.title}">
      </div>
      <div class="cart-item-details">
        <h3 class="cart-item-title">${item.title}</h3>
        <span class="cart-item-meta">Talla: ${item.size} | Color: ${item.color || 'Único'}</span>
        <div class="cart-item-qty">
          <button class="qty-btn" onclick="updateQty(${idx}, -1)"><i class="fa-solid fa-minus"></i></button>
          <span>${item.qty}</span>
          <button class="qty-btn" onclick="updateQty(${idx}, 1)"><i class="fa-solid fa-plus"></i></button>
        </div>
        <button class="remove-item-btn" onclick="removeCartItem(${idx})">Eliminar</button>
      </div>
      <div class="cart-item-price">
        $${(item.price * item.qty).toLocaleString()} MXN
      </div>
    </div>
  `).join('');
  
  // Update totals
  window.updateOrderSummaryTotals();
}

window.updateQty = function(idx, change) {
  const cart = JSON.parse(localStorage.getItem('paps_cart') || '[]');
  cart[idx].qty += change;
  if (cart[idx].qty < 1) cart[idx].qty = 1;
  localStorage.setItem('paps_cart', JSON.stringify(cart));
  renderCart();
  updateCartCount();
};

window.removeCartItem = function(idx) {
  const cart = JSON.parse(localStorage.getItem('paps_cart') || '[]');
  cart.splice(idx, 1);
  localStorage.setItem('paps_cart', JSON.stringify(cart));
  renderCart();
  updateCartCount();
};

// Fill Cart Form if customer is logged in
async function checkAndPrefillCartForm() {
  if (!getAuthToken()) return;
  try {
    const res = await fetchWithAuth('/api/customer/profile');
    if (res.ok) {
      const customer = await res.json();
      
      const nameInput = document.getElementById('client-name');
      const emailInput = document.getElementById('client-email');
      const phoneInput = document.getElementById('client-phone');
      
      if (nameInput) nameInput.value = customer.name;
      if (emailInput) emailInput.value = customer.email;
      if (phoneInput && customer.phone) phoneInput.value = customer.phone;
    }
  } catch (err) {
    console.error('Error prefilling checkout form:', err);
  }
}

// Handle Checkout Form Submission
async function handleCheckoutSubmit(e) {
  e.preventDefault();
  
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Cargando checkout seguro...';
  
  const customerName = document.getElementById('client-name').value.trim();
  const customerEmail = document.getElementById('client-email').value.trim();
  const customerPhone = document.getElementById('client-phone').value.trim();
  
  const street = document.getElementById('client-street').value.trim();
  const number = document.getElementById('client-number').value.trim();
  const neighborhood = document.getElementById('client-neighborhood').value.trim();
  const zip = document.getElementById('client-zip').value.trim();
  const city = document.getElementById('client-city').value.trim();
  const state = document.getElementById('client-state').value.trim();
  const company = document.getElementById('client-company').value.trim();
  const reference = document.getElementById('client-reference').value.trim();
  
  const companyPart = company ? `, Compañía: ${company}` : '';
  const shippingAddress = `${street} ${number}, ${neighborhood}, C.P. ${zip}, ${city}, ${state}, ${reference}${companyPart}`;
  
  const cart = JSON.parse(localStorage.getItem('paps_cart') || '[]');
  
  if (cart.length === 0) {
    alert('Tu carrito está vacío.');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Proceder al Pago';
    return;
  }

  if (typeof selectedShippingRate === 'undefined' || !selectedShippingRate) {
    alert('Por favor, ingresa tu Código Postal de 5 dígitos y selecciona una paquetería de envío.');
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<i class="fa-solid fa-lock"></i> Proceder al Pago';
    return;
  }
  
  try {
    const headers = { 'Content-Type': 'application/json' };
    const token = getAuthToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    
    const res = await fetch('/api/checkout', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        customerName,
        customerEmail,
        customerPhone,
        shippingAddress,
        shippingCarrier: selectedShippingRate.name,
        items: cart.map(i => ({ id: i.id, size: i.size, color: i.color, qty: i.qty })),
        couponCode: window.appliedCouponCode
      })
    });
    
    const data = await res.json();
    
    if (res.ok && data.checkoutUrl) {
      // Clear cart
      localStorage.removeItem('paps_cart');
      updateCartCount();
      
      // Redirect to payment simulator or Mercado Pago
      window.location.href = data.checkoutUrl;
    } else {
      alert(data.error || 'Ocurrió un error al procesar el checkout.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Proceder al Pago';
    }
  } catch (err) {
    console.error(err);
    alert('Error de conexión al procesar el pago.');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Proceder al Pago';
  }
}

// Load and render category filters dropdown
async function loadCategoryFilters() {
  const selectEl = document.getElementById('category-select');
  const selectElMobile = document.getElementById('mobile-category-select');
  if (!selectEl && !selectElMobile) return;
  
  try {
    let url = '/api/categories';
    if (currentGenderFilter && currentGenderFilter !== 'all') {
      url += `?gender=${encodeURIComponent(currentGenderFilter)}`;
    }
    
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to fetch categories');
    const categories = await res.json();
    
    if (selectEl) {
      let optionsHtml = `<option value="all">Todas las Categorías</option>`;
      optionsHtml += categories.map(cat => `<option value="${cat}">${cat}</option>`).join('');
      selectEl.innerHTML = optionsHtml;
      selectEl.value = currentCategoryFilter;
    }
    
    if (selectElMobile) {
      let optionsHtml = `<option value="all">Categorías</option>`;
      optionsHtml += categories.map(cat => `<option value="${cat}">${cat}</option>`).join('');
      selectElMobile.innerHTML = optionsHtml;
      selectElMobile.value = currentCategoryFilter;
    }
  } catch (err) {
    console.error('Error loading category filters:', err);
    if (selectEl) selectEl.innerHTML = '<option value="all">Todas las Categorías</option>';
    if (selectElMobile) selectElMobile.innerHTML = '<option value="all">Categorías</option>';
  }
}

// Load and render brand filters dropdown
async function loadBrandFilters() {
  const selectEl = document.getElementById('brand-select');
  const selectElMobile = document.getElementById('mobile-brand-select');
  if (!selectEl && !selectElMobile) return;
  
  try {
    const res = await fetch('/api/brands');
    if (!res.ok) throw new Error('Failed to fetch brands');
    const brands = await res.json();
    
    if (selectEl) {
      let optionsHtml = `<option value="all">Todas las Marcas</option>`;
      optionsHtml += brands.map(brand => `<option value="${brand}">${brand}</option>`).join('');
      selectEl.innerHTML = optionsHtml;
      selectEl.value = currentBrandFilter;
    }
    
    if (selectElMobile) {
      let optionsHtml = `<option value="all">Marcas</option>`;
      optionsHtml += brands.map(brand => `<option value="${brand}">${brand}</option>`).join('');
      selectElMobile.innerHTML = optionsHtml;
      selectElMobile.value = currentBrandFilter;
    }
  } catch (err) {
    console.error('Error loading brand filters:', err);
    if (selectEl) selectEl.innerHTML = '<option value="all">Todas las Marcas</option>';
    if (selectElMobile) selectElMobile.innerHTML = '<option value="all">Marcas</option>';
  }
}

/* --- Dynamic Categories Grid Panel --- */
async function renderCategoriesGrid() {
  const gridEl = document.getElementById('categories-list-grid');
  if (!gridEl) return;
  
  gridEl.innerHTML = `
    <div style="grid-column: 1/-1; text-align: center; padding: 48px; color: var(--text-secondary);">
      <i class="fa-solid fa-spinner fa-spin" style="font-size: 24px; margin-bottom: 12px;"></i>
      <p>Cargando categorías...</p>
    </div>
  `;
  
  try {
    const res = await fetch('/api/categories');
    if (!res.ok) throw new Error('Failed to fetch categories');
    const categories = await res.json();
    
    const icons = ['fa-shoe-prints', 'fa-running', 'fa-boot', 'fa-socks', 'fa-person-running', 'fa-shapes'];
    
    gridEl.innerHTML = categories.map((cat, idx) => {
      const icon = icons[idx % icons.length];
      return `
        <div class="category-card" onclick="selectCategoryFromGrid('${cat}')">
          <i class="fa-solid ${icon}"></i>
          <span>${cat}</span>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error(err);
    gridEl.innerHTML = '<p style="color: #ff3b30; grid-column: 1/-1;">Error al cargar las categorías.</p>';
  }
}

window.selectCategoryFromGrid = async function(category) {
  // Usar selectCategory() directamente para mostrar el catálogo con productos
  // sin pasar por showMainLanding() que dejaba la pantalla vacía en el primer click
  await selectCategory(category);
};

/* --- Dynamic Trends Grid Panel --- */
async function renderTrendsGrid() {
  const gridEl = document.getElementById('trends-product-grid');
  if (!gridEl) return;
  
  gridEl.innerHTML = `
    <div style="grid-column: 1/-1; text-align: center; padding: 48px; color: var(--text-secondary);">
      <i class="fa-solid fa-spinner fa-spin" style="font-size: 24px; margin-bottom: 12px;"></i>
      <p>Cargando tendencias...</p>
    </div>
  `;
  
  try {
    const res = await fetchWithAuth('/api/products/trends');
    if (!res.ok) throw new Error('Failed to fetch trends');
    const products = await res.json();
    
    if (products.length === 0) {
      gridEl.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; padding: 48px; color: var(--text-secondary);">
          <i class="fa-solid fa-store-slash" style="font-size: 32px; margin-bottom: 12px; color: #ccc;"></i>
          <p>No hay productos con ventas en esta tienda todavía. ¡Sé el primero en comprar!</p>
        </div>
      `;
      return;
    }
    
    renderProductListToGrid(products, gridEl);
  } catch (err) {
    console.error(err);
    gridEl.innerHTML = '<p style="color: #ff3b30; grid-column: 1/-1;">Error al cargar las tendencias.</p>';
  }
}

/* --- Customer Auth Handling --- */
window.switchAuthTab = function(type) {
  document.getElementById('auth-tab-login').classList.remove('active');
  document.getElementById('auth-tab-register').classList.remove('active');
  document.getElementById('login-form-wrapper').classList.remove('active');
  document.getElementById('register-form-wrapper').classList.remove('active');
  
  if (type === 'login') {
    document.getElementById('auth-tab-login').classList.add('active');
    document.getElementById('login-form-wrapper').classList.add('active');
  } else {
    document.getElementById('auth-tab-register').classList.add('active');
    document.getElementById('register-form-wrapper').classList.add('active');
  }
};

window.handleCustomerLogin = async function(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  
  try {
    const res = await fetch('/api/customer/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    
    if (res.ok && data.token) {
      setAuthToken(data.token);
      showDashboard();
      document.getElementById('customer-login-form').reset();
    } else {
      alert(data.error || 'Credenciales incorrectas.');
    }
  } catch (err) {
    console.error(err);
    alert('Error al conectar con el servidor.');
  }
};

window.handleCustomerRegister = async function(e) {
  e.preventDefault();
  const name = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const phone = document.getElementById('reg-phone').value.trim();
  const password = document.getElementById('reg-password').value;
  
  try {
    const res = await fetch('/api/customer/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, phone, password })
    });
    const data = await res.json();
    
    if (res.ok) {
      alert('¡Cuenta creada con éxito! Iniciando sesión automáticamente...');
      
      const loginRes = await fetch('/api/customer/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const loginData = await loginRes.json();
      if (loginRes.ok && loginData.token) {
        setAuthToken(loginData.token);
        showDashboard();
      } else {
        switchAuthTab('login');
      }
      document.getElementById('customer-register-form').reset();
    } else {
      alert(data.error || 'Error al registrarse.');
    }
  } catch (err) {
    console.error(err);
    alert('Error al conectar con el servidor.');
  }
};

window.handleCustomerLogout = function() {
  setAuthToken(null);
  switchTab('home');
};

function showAuth() {
  document.getElementById('auth-section').style.display = 'block';
  document.getElementById('dashboard-section').style.display = 'none';
}

async function showDashboard() {
  document.getElementById('auth-section').style.display = 'none';
  document.getElementById('dashboard-section').style.display = 'grid';
  
  try {
    const res = await fetchWithAuth('/api/customer/profile');
    if (!res.ok) {
      handleCustomerLogout();
      return;
    }
    const customer = await res.json();
    window.currentCustomer = customer;
    
    // Set edit inputs
    const editName = document.getElementById('profile-edit-name');
    const editEmail = document.getElementById('profile-edit-email');
    const editPhone = document.getElementById('profile-edit-phone');
    
    if (editName) editName.value = customer.name;
    if (editEmail) editEmail.value = customer.email;
    if (editPhone) editPhone.value = customer.phone || '';
    
    document.getElementById('profile-date').textContent = new Date(customer.created_at).toLocaleDateString('es-MX', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    
    switchDashboardTab('profile');
  } catch (err) {
    console.error(err);
    handleCustomerLogout();
  }
}

window.switchDashboardTab = function(tabName) {
  const tabs = ['profile', 'orders', 'favorites', 'coupons', 'track'];
  tabs.forEach(t => {
    const el = document.getElementById(`db-tab-${t}`);
    if (el) el.classList.remove('active');
    const btn = document.getElementById(`db-tab-btn-${t}`);
    if (btn) btn.classList.remove('active');
  });
  
  const activeEl = document.getElementById(`db-tab-${tabName}`);
  if (activeEl) activeEl.classList.add('active');
  const activeBtn = document.getElementById(`db-tab-btn-${tabName}`);
  if (activeBtn) activeBtn.classList.add('active');
  
  if (tabName === 'orders') {
    loadDashboardOrders();
  } else if (tabName === 'favorites') {
    loadDashboardFavorites();
  } else if (tabName === 'coupons') {
    loadDashboardCoupons();
  }
};

async function loadDashboardCoupons() {
  const listEl = document.getElementById('profile-coupons-list');
  if (!listEl) return;
  
  listEl.innerHTML = `
    <div style="text-align: center; padding: 32px; color: var(--text-secondary);">
      <i class="fa-solid fa-spinner fa-spin" style="font-size: 20px; margin-bottom: 8px;"></i>
      <p>Cargando tus descuentos...</p>
    </div>
  `;
  
  try {
    const res = await fetchWithAuth('/api/coupons');
    if (!res.ok) throw new Error('Failed to fetch coupons');
    const data = await res.json();
    
    const coupons = data.coupons || [];
    if (coupons.length === 0) {
      listEl.innerHTML = '<p style="color: var(--text-secondary); text-align: center; padding: 16px;">No tienes cupones disponibles en este momento.</p>';
      return;
    }
    
    listEl.innerHTML = coupons.map(coupon => `
      <div class="coupon-box" style="border: 1px dashed #ddd; padding: 16px; border-radius: 8px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; background: #fff;">
        <div>
          <div style="font-weight: 600; font-size: 14px; color: var(--text-primary);">${coupon.description || 'Descuento disponible'}</div>
          <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">Valor: ${coupon.discount_percent}% de descuento</div>
        </div>
        <span class="coupon-code" onclick="copyCoupon('${coupon.code}')" style="cursor: pointer; background: #e2e8f0; color: #475569; padding: 6px 12px; border-radius: 4px; font-weight: 700; font-family: monospace; font-size: 13px;">${coupon.code}</span>
      </div>
    `).join('');
  } catch (err) {
    console.error(err);
    listEl.innerHTML = '<p style="color: #e53e3e; text-align: center; padding: 16px;">Error al cargar tus cupones. Inténtalo de nuevo.</p>';
  }
}

async function loadDashboardOrders() {
  const listEl = document.getElementById('profile-orders-list');
  if (!listEl) return;
  
  listEl.innerHTML = `
    <div style="text-align: center; padding: 32px; color: var(--text-secondary);">
      <i class="fa-solid fa-spinner fa-spin" style="font-size: 20px; margin-bottom: 8px;"></i>
      <p>Cargando tus compras...</p>
    </div>
  `;
  
  try {
    const res = await fetchWithAuth('/api/customer/orders');
    if (!res.ok) throw new Error('Failed to fetch orders');
    const orders = await res.json();
    
    if (orders.length === 0) {
      listEl.innerHTML = '<p style="color: var(--text-secondary);">No has realizado ninguna compra todavía.</p>';
      return;
    }
    
    listEl.innerHTML = orders.map(order => {
      const dateStr = new Date(order.created_at).toLocaleDateString('es-MX', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
      
      const itemsHtml = order.items.map(item => {
        const ratingWidgetHtml = (order.status === 'paid' || order.status === 'purchased_on_supplier' || order.status === 'shipped')
          ? `
            <div class="order-item-rating-box">
              <span class="order-item-rating-label">Tu Calificación:</span>
              <div class="stars-interactive" data-order-id="${order.id}" data-product-id="${item.id}" data-rating="${item.userRating || 0}">
                ${[1, 2, 3, 4, 5].map(star => {
                  const activeClass = star <= (item.userRating || 0) ? 'selected' : '';
                  return `<i class="fa-solid fa-star ${activeClass}" onclick="handleStarClick(this, ${star})" onmouseover="handleStarHover(this, ${star})" onmouseout="handleStarReset(this)"></i>`;
                }).join('')}
              </div>
            </div>
          `
          : '';

        return `
          <div class="order-item-row">
            <div class="order-item-info">
              <span class="order-item-title" style="font-weight: 500;">${item.title}</span>
              <span class="order-item-meta">Talla: ${item.size} | Color: ${item.color || 'Único'} | Cantidad: ${item.qty}</span>
              ${ratingWidgetHtml}
            </div>
            <span style="font-weight: 500; font-size: 14px;">$${(item.price * item.qty).toLocaleString()} MXN</span>
          </div>
        `;
      }).join('');
      
      let statusBadge = '';
      if (order.status === 'pending') statusBadge = '<span class="badge pending">Pendiente</span>';
      else if (order.status === 'paid') statusBadge = '<span class="badge paid">Pagado</span>';
      else if (order.status === 'purchased_on_supplier') statusBadge = '<span class="badge paid">Procesado</span>';
      else if (order.status === 'shipped') statusBadge = '<span class="badge shipped">Enviado</span>';

      return `
        <div class="order-card">
          <div class="order-card-header">
            <div>
              <span class="order-folio">${order.id}</span>
              <span class="order-date">(${dateStr})</span>
            </div>
            ${statusBadge}
          </div>
          <div class="order-items-container">
            ${itemsHtml}
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center; margin-top:16px; font-weight:600; font-size:14px; border-top: 1px dashed var(--border-color); padding-top:12px;">
            <a href="javascript:void(0)" onclick="quickTrackOrder('${order.id}')" style="color: #007aff; text-decoration: none; font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 6px;">
              <i class="fa-solid fa-location-dot"></i> Rastrear Pedido
            </a>
            <div style="text-align: right;">
              <span style="font-weight: 400; font-size: 13px; color: var(--text-secondary); margin-right: 8px;">Total:</span>
              <span>$${order.total.toLocaleString()} MXN</span>
            </div>
          </div>
          ${order.tracking_number ? `
            <div class="tracking-info-box" style="margin-top:12px; background-color: #f9f9f9; padding: 10px; border-radius: 6px; border: 1px solid var(--border-color);">
              <p style="margin: 0 0 4px; font-size: 12px;"><strong>Paquetería:</strong> ${order.shipping_carrier || 'DHL'}</p>
              <p style="margin: 0; font-size: 12px;"><strong>Guía:</strong> ${order.tracking_number}</p>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error(err);
    listEl.innerHTML = '<p style="color: #ff3b30;">Error al cargar las compras.</p>';
  }
}

async function loadDashboardFavorites() {
  const gridEl = document.getElementById('profile-favorites-grid');
  if (!gridEl) return;
  
  gridEl.innerHTML = `
    <div style="grid-column: 1/-1; text-align: center; padding: 32px; color: var(--text-secondary);">
      <i class="fa-solid fa-spinner fa-spin" style="font-size: 20px; margin-bottom: 8px;"></i>
      <p>Cargando favoritos...</p>
    </div>
  `;
  
  try {
    const res = await fetchWithAuth('/api/customer/favorites');
    if (!res.ok) throw new Error('Failed to fetch favorites');
    const favs = await res.json();
    
    if (favs.length === 0) {
      gridEl.innerHTML = '<p style="color: var(--text-secondary); grid-column: 1/-1;">No tienes calzados guardados.</p>';
      return;
    }
    
    renderProductListToGrid(favs, gridEl);
  } catch (err) {
    console.error(err);
    gridEl.innerHTML = '<p style="color: #ff3b30; grid-column: 1/-1;">Error al cargar favoritos.</p>';
  }
}

// Interactive Star Ratings inside order history
window.handleStarHover = function(starEl, rating) {
  const container = starEl.closest('.stars-interactive');
  const stars = container.querySelectorAll('i');
  stars.forEach((s, idx) => {
    if (idx < rating) {
      s.classList.add('hovered');
    } else {
      s.classList.remove('hovered');
    }
  });
};

window.handleStarReset = function(starEl) {
  const container = starEl.closest('.stars-interactive');
  const stars = container.querySelectorAll('i');
  stars.forEach(s => s.classList.remove('hovered'));
};

window.handleStarClick = async function(starEl, rating) {
  const container = starEl.closest('.stars-interactive');
  const orderId = container.getAttribute('data-order-id');
  const productId = container.getAttribute('data-product-id');
  
  try {
    const res = await fetchWithAuth(`/api/customer/orders/${orderId}/rate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, rating })
    });
    
    if (res.ok) {
      container.setAttribute('data-rating', rating);
      const stars = container.querySelectorAll('i');
      stars.forEach((s, idx) => {
        if (idx < rating) {
          s.classList.add('selected');
        } else {
          s.classList.remove('selected');
        }
      });
      alert('¡Calificación guardada correctamente! Muchas gracias.');
    } else {
      const data = await res.json();
      alert(data.error || 'Error al guardar la calificación.');
    }
  } catch (err) {
    console.error(err);
    alert('Error al enviar la calificación.');
  }
};

window.copyCoupon = function(code) {
  navigator.clipboard.writeText(code).then(() => {
    alert(`¡Cupón "${code}" copiado al portapapeles!`);
  }).catch(() => {
    alert(`Código de cupón: ${code}`);
  });
};

// Automatically reload/re-render product grids if crossing the mobile/desktop boundary on resize
let lastWidth = window.innerWidth;
window.addEventListener('resize', () => {
  const currentWidth = window.innerWidth;
  if ((lastWidth > 768 && currentWidth <= 768) || (lastWidth <= 768 && currentWidth > 768)) {
    lastWidth = currentWidth;
    if (typeof currentTab !== 'undefined') {
      if (currentTab === 'home') {
        renderProducts();
      } else if (currentTab === 'trends') {
        renderTrendsGrid();
      } else if (currentTab === 'menu') {
        loadDashboardFavorites();
      }
    }
  }
});

/* ==========================================
   MOBILE SLIDE-UP MENU SHEET
   ========================================== */

window.toggleMobileMenu = function() {
  const overlay = document.getElementById('mobile-menu-overlay');
  const sheet   = document.getElementById('mobile-menu-sheet');
  if (!overlay || !sheet) return;

  const isOpen = sheet.classList.contains('active');
  if (isOpen) {
    closeMobileMenu();
  } else {
    overlay.style.display = 'block';
    // Force reflow for transition
    overlay.getBoundingClientRect();
    overlay.classList.add('active');
    sheet.classList.add('active');
    document.body.style.overflow = 'hidden';
  }
};

window.closeMobileMenu = function() {
  const overlay = document.getElementById('mobile-menu-overlay');
  const sheet   = document.getElementById('mobile-menu-sheet');
  if (!overlay || !sheet) return;

  overlay.classList.remove('active');
  sheet.classList.remove('active');
  document.body.style.overflow = '';

  // Hide overlay after transition ends
  setTimeout(() => {
    overlay.style.display = 'none';
  }, 380);
};

window.openMenuSection = function(section) {
  closeMobileMenu();
  // Navigate to the menu tab and open the specific dashboard section
  setTimeout(() => {
    switchTab('menu');
    if (getAuthToken()) {
      // User is logged in — go directly to the requested tab
      switchDashboardTab(section);
    }
    // If not logged in, the auth form will be shown naturally
  }, 200);
};

// Update profile details
window.handleProfileUpdate = async function(e) {
  e.preventDefault();
  const name = document.getElementById('profile-edit-name').value.trim();
  const phone = document.getElementById('profile-edit-phone').value.trim();
  const password = document.getElementById('profile-edit-password').value;
  
  const msgEl = document.getElementById('profile-update-message');
  msgEl.style.display = 'block';
  msgEl.style.color = 'var(--text-primary)';
  msgEl.textContent = 'Guardando cambios...';
  
  try {
    const res = await fetchWithAuth('/api/customer/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, password })
    });
    const data = await res.json();
    if (res.ok) {
      msgEl.style.color = '#34c759'; // Success green
      msgEl.textContent = 'Perfil actualizado exitosamente.';
      document.getElementById('profile-edit-password').value = '';
      
      if (window.currentCustomer) {
        window.currentCustomer.name = name;
        window.currentCustomer.phone = phone;
      }
      
      setTimeout(() => {
        msgEl.style.display = 'none';
        showDashboard();
      }, 1500);
    } else {
      msgEl.style.color = '#ff3b30'; // Error red
      msgEl.textContent = data.error || 'Error al actualizar el perfil.';
    }
  } catch (err) {
    console.error(err);
    msgEl.style.color = '#ff3b30';
    msgEl.textContent = 'Error de conexión. Intenta de nuevo.';
  }
};

// Dashboard tracking handler
window.handleDbTrackingSubmit = async function(e) {
  e.preventDefault();
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Buscando...';
  
  const folio = document.getElementById('db-track-folio').value.toUpperCase().trim();
  const contact = document.getElementById('db-track-contact').value.trim();
  
  const resultDiv = document.getElementById('db-tracking-result');
  
  try {
    const res = await fetch('/api/orders/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folio, contact })
    });
    
    const data = await res.json();
    
    if (res.ok) {
      resultDiv.style.display = 'block';
      document.getElementById('db-result-folio').textContent = `Pedido: ${data.folio}`;
      
      const date = new Date(data.createdAt);
      document.getElementById('db-result-date').textContent = `Fecha: ${date.toLocaleDateString()} ${date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`;
      
      // Update timeline
      const steps = ['compra_realizada', 'recolectado', 'centro_distribucion', 'en_ruta', 'entregado'];
      steps.forEach(s => {
        const el = document.getElementById(`db-step-${s}`);
        if (el) el.className = 'timeline-step';
      });
      const index = steps.indexOf(data.trackingStatus);
      if (index !== -1) {
        for (let i = 0; i <= index; i++) {
          const el = document.getElementById(`db-step-${steps[i]}`);
          if (el) {
            el.classList.add('completed');
            if (i === index) el.classList.add('current');
          }
        }
      }
      
      // Update shipping info
      const shippingBox = document.getElementById('db-shipping-info-box');
      const eventsBox = document.getElementById('db-logistics-events-box');
      const eventsList = document.getElementById('db-logistics-events-list');
      
      if (data.trackingNumber) {
        shippingBox.style.display = 'block';
        document.getElementById('db-carrier-name').textContent = data.shippingCarrier || 'Pendiente';
        document.getElementById('db-tracking-code').textContent = data.trackingNumber;
        
        const carrierLink = document.getElementById('db-carrier-link');
        const carrier = (data.shippingCarrier || '').toUpperCase();
        if (carrier.includes('DHL')) {
          carrierLink.href = `https://www.dhl.com/es-es/home/tracking/tracking-express.html?submit=1&tracking-id=${data.trackingNumber}`;
        } else if (carrier.includes('FEDEX')) {
          carrierLink.href = `https://www.fedex.com/fedextrack/?trknbr=${data.trackingNumber}`;
        } else if (carrier.includes('ESTAFETA')) {
          carrierLink.href = `https://www.estafeta.com/Herramientas/Rastreo`;
        } else {
          carrierLink.href = `https://www.google.com/search?q=rastreo+${encodeURIComponent(data.shippingCarrier || '')}+${encodeURIComponent(data.trackingNumber)}`;
        }
        
        // Fetch logistics events
        eventsBox.style.display = 'block';
        eventsList.innerHTML = '<p style="font-size: 13px; color: var(--text-secondary);"><i class="fa-solid fa-spinner fa-spin"></i> Cargando historial...</p>';
        try {
          const eventsRes = await fetch(`/api/shipping/track/${data.trackingNumber}`);
          if (eventsRes.ok) {
            const eventsData = await eventsRes.json();
            if (eventsData.events && eventsData.events.length > 0) {
              eventsList.innerHTML = eventsData.events.map(event => {
                const ed = new Date(event.timestamp);
                const edStr = `${ed.toLocaleDateString('es-MX')} ${ed.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`;
                return `
                  <div style="display: flex; gap: 12px; font-size: 13px; line-height: 1.4; border-bottom: 1px dashed var(--border-color); padding-bottom: 10px;">
                    <div style="color: var(--text-secondary); font-size: 11px; font-weight: 600; white-space: nowrap; width: 110px; padding-top: 2px;">${edStr}</div>
                    <div style="flex-grow: 1;">
                      <div style="font-weight: 600; color: var(--text-primary);">${event.title}</div>
                      <div style="color: var(--text-secondary); font-size: 12px; margin-top: 2px;">${event.description}</div>
                      <div style="font-size: 11px; font-weight: 600; color: #007aff; margin-top: 4px; display: flex; align-items: center; gap: 4px;">
                        <i class="fa-solid fa-location-dot"></i> ${event.location}
                      </div>
                    </div>
                  </div>
                `;
              }).join('');
            } else {
              eventsList.innerHTML = '<p style="font-size: 13px; color: var(--text-secondary);">No hay movimientos registrados.</p>';
            }
          } else {
            eventsList.innerHTML = '<p style="font-size: 13px; color: var(--text-secondary);">Sin historial de eventos.</p>';
          }
        } catch (eErr) {
          console.error(eErr);
          eventsList.innerHTML = '<p style="font-size: 13px; color: #ff3b30;">Error al obtener movimientos.</p>';
        }
      } else {
        shippingBox.style.display = 'none';
        eventsBox.style.display = 'none';
      }
      
      // Items list
      const itemsContainer = document.getElementById('db-result-items');
      itemsContainer.innerHTML = data.items.map(item => `
        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 14px; padding: 8px 0; border-bottom: 1px solid var(--border-color);">
          <div>
            <span style="font-weight: 500;">${item.title}</span><br>
            <span style="font-size: 12px; color: var(--text-secondary);">Talla: ${item.size} | Color: ${item.color} | Cantidad: ${item.qty}</span>
          </div>
          <span style="font-weight: 600;">$${(item.price * item.qty).toLocaleString()} MXN</span>
        </div>
      `).join('');
      
    } else {
      alert(data.error || 'No se pudo encontrar el pedido. Verifica los datos.');
      resultDiv.style.display = 'none';
    }
  } catch (err) {
    console.error(err);
    alert('Error al consultar el rastreo.');
    resultDiv.style.display = 'none';
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> Consultar Estado';
  }
};

window.quickTrackOrder = function(folio) {
  switchDashboardTab('track');
  const folioInput = document.getElementById('db-track-folio');
  const contactInput = document.getElementById('db-track-contact');
  if (folioInput && contactInput) {
    folioInput.value = folio;
    contactInput.value = window.currentCustomer ? window.currentCustomer.email : '';
    const form = document.getElementById('db-tracking-form');
    if (form) {
      setTimeout(() => {
        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      }, 100);
    }
  }
};

/* ==========================================
   SHIPPING CALCULATION & SELECTION HANDLERS
   ========================================== */
window.fetchShippingQuotes = async function(zip) {
  const wrapper = document.getElementById('shipping-methods-wrapper');
  const ratesList = document.getElementById('shipping-rates-list');
  if (!wrapper || !ratesList) return;
  
  wrapper.style.display = 'block';
  ratesList.innerHTML = `
    <div class="shipping-loading">
      <i class="fa-solid fa-spinner fa-spin" style="margin-right: 6px;"></i> Cotizando envío...
    </div>
  `;
  
  try {
    const cart = JSON.parse(localStorage.getItem('paps_cart') || '[]');
    const itemsCount = cart.reduce((sum, item) => sum + item.qty, 0);
    
    const res = await fetch('/api/shipping/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zip_to: zip, items_count: itemsCount })
    });
    
    if (!res.ok) {
      throw new Error('Error al cotizar envío');
    }
    
    const data = await res.json();
    const rates = data.rates || [];
    
    if (rates.length === 0) {
      ratesList.innerHTML = `
        <div class="shipping-error">
          No hay paqueterías de envío disponibles para el C.P. ${zip}.
        </div>
      `;
      resetShippingChoice();
      return;
    }
    
    // Render the cards
    ratesList.innerHTML = rates.map((rate, idx) => {
      const carrierCombined = `${rate.carrier} - ${rate.service}`;
      return `
        <label class="shipping-rate-card" id="shipping-rate-card-${idx}">
          <input type="radio" name="shipping_rate" class="shipping-radio" value="${carrierCombined}" onchange="selectShippingRate(this, ${idx}, ${rate.total}, '${carrierCombined}')">
          <div class="shipping-rate-details">
            <div class="carrier-info">
              <span class="carrier-name">${rate.carrier}</span>
              <span class="carrier-service">${rate.service}</span>
            </div>
            <span class="carrier-price">$${rate.total.toLocaleString()} MXN</span>
          </div>
        </label>
      `;
    }).join('');
    
    // Pre-select the first rate option automatically
    const firstRadio = ratesList.querySelector('input[name="shipping_rate"]');
    if (firstRadio) {
      selectShippingRate(firstRadio, 0, rates[0].total, `${rates[0].carrier} - ${rates[0].service}`);
    }
    
  } catch (err) {
    console.error('Error fetching shipping rates:', err);
    ratesList.innerHTML = `
      <div class="shipping-error">
        Error al cotizar el envío. Intente de nuevo.
      </div>
    `;
    resetShippingChoice();
  }
};

window.updateOrderSummaryTotals = function() {
  const cart = JSON.parse(localStorage.getItem('paps_cart') || '[]');
  const subtotal = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
  
  const discountPercent = window.appliedDiscountPercent || 0;
  const discountAmount = subtotal * (discountPercent / 100);
  const discountedSubtotal = subtotal - discountAmount;
  
  const shippingCost = window.selectedShippingRate ? window.selectedShippingRate.price : 0;
  const total = Math.max(0, Math.round((discountedSubtotal + shippingCost) * 100) / 100);

  // Update UI Elements
  const subtotalEl = document.getElementById('summary-subtotal');
  if (subtotalEl) {
    subtotalEl.textContent = `$${subtotal.toLocaleString()} MXN`;
  }

  const discountRow = document.getElementById('summary-discount-row');
  const discountPercentEl = document.getElementById('summary-discount-percent');
  const discountValueEl = document.getElementById('summary-discount-value');
  
  if (discountRow) {
    if (discountPercent > 0) {
      discountRow.style.display = 'flex';
      if (discountPercentEl) discountPercentEl.textContent = discountPercent;
      if (discountValueEl) discountValueEl.textContent = `-$${discountAmount.toLocaleString()} MXN`;
    } else {
      discountRow.style.display = 'none';
    }
  }

  const shippingEl = document.getElementById('summary-shipping');
  if (shippingEl) {
    if (window.selectedShippingRate) {
      shippingEl.textContent = `$${shippingCost.toLocaleString()} MXN`;
      shippingEl.style.color = 'var(--text-primary)';
      shippingEl.style.fontWeight = '600';
    } else {
      shippingEl.textContent = 'Por cotizar';
      shippingEl.style.color = 'var(--text-secondary)';
      shippingEl.style.fontWeight = '500';
    }
  }

  const totalEl = document.getElementById('summary-total-value');
  if (totalEl) {
    totalEl.textContent = `$${total.toLocaleString()} MXN`;
  }
};

window.applyCoupon = async function() {
  const inputEl = document.getElementById('coupon-code-input');
  const messageEl = document.getElementById('coupon-message');
  if (!inputEl) return;
  
  const code = inputEl.value.trim();
  if (!code) {
    if (messageEl) {
      messageEl.textContent = 'Por favor ingresa un código de cupón.';
      messageEl.style.color = '#e53e3e';
      messageEl.style.display = 'block';
    }
    return;
  }

  if (!getAuthToken()) {
    if (messageEl) {
      messageEl.textContent = 'Inicia sesión para aplicar un cupón.';
      messageEl.style.color = '#e53e3e';
      messageEl.style.display = 'block';
    }
    return;
  }
  
  try {
    const res = await fetchWithAuth('/api/coupons/validate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ code })
    });
    
    const data = await res.json();
    if (res.ok && data.success) {
      window.appliedCouponCode = data.code;
      window.appliedDiscountPercent = data.discount_percent;
      
      if (messageEl) {
        messageEl.textContent = `Cupón aplicado: ${data.description || `${data.discount_percent}% de descuento`}`;
        messageEl.style.color = '#38a169';
        messageEl.style.display = 'block';
      }
      
      window.updateOrderSummaryTotals();
    } else {
      window.appliedCouponCode = null;
      window.appliedDiscountPercent = 0;
      if (messageEl) {
        messageEl.textContent = data.error || 'El cupón no es válido.';
        messageEl.style.color = '#e53e3e';
        messageEl.style.display = 'block';
      }
      window.updateOrderSummaryTotals();
    }
  } catch (err) {
    console.error('Error validating coupon:', err);
    window.appliedCouponCode = null;
    window.appliedDiscountPercent = 0;
    if (messageEl) {
      messageEl.textContent = 'Error al validar el cupón. Inténtalo de nuevo.';
      messageEl.style.color = '#e53e3e';
      messageEl.style.display = 'block';
    }
    window.updateOrderSummaryTotals();
  }
};

window.selectShippingRate = function(radioInput, idx, price, carrierName) {
  // Set the active class on the card
  const cards = document.querySelectorAll('.shipping-rate-card');
  cards.forEach(card => card.classList.remove('active'));
  
  const selectedCard = document.getElementById(`shipping-rate-card-${idx}`);
  if (selectedCard) {
    selectedCard.classList.add('active');
  }
  
  // Ensure the radio input is checked (useful if called programmatically)
  if (radioInput) {
    radioInput.checked = true;
  }
  
  // Save selected rate to global and window variable
  const selection = { name: carrierName, price: price };
  selectedShippingRate = selection;
  window.selectedShippingRate = selection;
  
  // Update checkout summary
  window.updateOrderSummaryTotals();
};

window.resetShippingChoice = function() {
  selectedShippingRate = null;
  window.selectedShippingRate = null;
  
  // Update checkout summary
  window.updateOrderSummaryTotals();
};

// Hero Carousel Logic
function initHeroCarousel() {
  const container = document.querySelector('.hero-carousel-container');
  const track = document.getElementById('hero-carousel-track');
  if (!container || !track) return;

  const slides = track.querySelectorAll('.carousel-slide');
  if (slides.length === 0) return;

  currentCarouselSlideIdx = 0;
  
  // Create dots dynamically
  const dotsContainer = document.getElementById('carousel-dots-container');
  if (dotsContainer) {
    dotsContainer.innerHTML = '';
    slides.forEach((_, idx) => {
      const dot = document.createElement('div');
      dot.className = `carousel-dot${idx === 0 ? ' active' : ''}`;
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        goToCarouselSlide(idx);
      });
      dotsContainer.appendChild(dot);
    });
  }

  // Bind arrows if present
  const prevArrow = container.querySelector('.carousel-arrow.prev');
  const nextArrow = container.querySelector('.carousel-arrow.next');
  
  if (prevArrow) {
    prevArrow.onclick = (e) => {
      e.stopPropagation();
      moveCarousel(-1);
    };
  }
  if (nextArrow) {
    nextArrow.onclick = (e) => {
      e.stopPropagation();
      moveCarousel(1);
    };
  }

  // Smooth scroll for catalog buttons
  const slideBtns = container.querySelectorAll('.slide-btn');
  slideBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      const targetId = btn.getAttribute('href');
      if (targetId && targetId.startsWith('#')) {
        e.preventDefault();
        e.stopPropagation();
        const targetEl = document.querySelector(targetId);
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: 'smooth' });
        }
      }
    });
  });

  // Start auto-slide timer
  startCarouselTimer();

  // Pause on hover
  container.addEventListener('mouseenter', stopCarouselTimer);
  container.addEventListener('mouseleave', startCarouselTimer);
}

function startCarouselTimer() {
  stopCarouselTimer();
  carouselTimer = setInterval(() => {
    moveCarousel(1);
  }, 6000); // auto-slide every 6 seconds
}

function stopCarouselTimer() {
  if (carouselTimer) {
    clearInterval(carouselTimer);
    carouselTimer = null;
  }
}

function goToCarouselSlide(index) {
  const track = document.getElementById('hero-carousel-track');
  if (!track) return;
  const slides = track.querySelectorAll('.carousel-slide');
  const dots = document.querySelectorAll('.carousel-dot');
  
  if (slides.length === 0) return;

  // Handle bounds
  if (index >= slides.length) {
    currentCarouselSlideIdx = 0;
  } else if (index < 0) {
    currentCarouselSlideIdx = slides.length - 1;
  } else {
    currentCarouselSlideIdx = index;
  }

  // Update active slide
  slides.forEach((slide, idx) => {
    if (idx === currentCarouselSlideIdx) {
      slide.classList.add('active');
    } else {
      slide.classList.remove('active');
    }
  });

  // Update active dot
  dots.forEach((dot, idx) => {
    if (idx === currentCarouselSlideIdx) {
      dot.classList.add('active');
    } else {
      dot.classList.remove('active');
    }
  });
}

function moveCarousel(direction) {
  goToCarouselSlide(currentCarouselSlideIdx + direction);
}

// Make moveCarousel global so the inline HTML onclick works
window.moveCarousel = moveCarousel;

/* --- Category Catalog Filtering, Rendering & Navigation --- */
let categoryBaseProducts = [];
let categoryFilteredProducts = [];
let categoryCurrentPage = 0;
let categoryScrollObserver = null;

// Guarantee allProducts is loaded before any category filter runs.
// Fixes race condition where selectCategory() fires before /api/products fetch completes.
let _productsLoadPromise = null;
async function ensureProductsLoaded() {
  if (allProducts.length > 0) return;
  if (_productsLoadPromise) return _productsLoadPromise;
  _productsLoadPromise = fetchWithAuth('/api/products?limit=24&page=0')
    .then(res => {
      if (!res.ok) throw new Error('Failed to fetch catalog');
      return res.json();
    })
    .then(data => {
      allProducts = Array.isArray(data) ? data : (data.products || []);
      _productsLoadPromise = null;
    })
    .catch(err => {
      _productsLoadPromise = null;
      console.error('[ensureProductsLoaded]', err);
    });
  return _productsLoadPromise;
}

window.selectCategory = async function(categoryName) {
  currentSelectedCategory = categoryName;
  categoryBrandFilter = 'all';
  categoryCurrentPage = 0;

  // Toggle sections visibility
  const landingContainer = document.getElementById('main-landing-container');
  const catalogContainer = document.getElementById('category-catalog-container');
  if (landingContainer) landingContainer.style.display = 'none';
  if (catalogContainer) catalogContainer.style.display = 'block';

  // Set category title
  const titleEl = document.getElementById('category-catalog-title');
  if (titleEl) titleEl.textContent = categoryName;

  // Hide mobile search/filters bar
  const mobileBar = document.querySelector('.mobile-search-filters');
  if (mobileBar) mobileBar.classList.add('hidden');

  // Show loading state immediately
  const gridEl = document.getElementById('category-product-grid');
  if (gridEl) {
    gridEl.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 48px; color: var(--text-secondary);">
        <i class="fa-solid fa-spinner fa-spin" style="font-size: 24px; margin-bottom: 12px;"></i>
        <p>Cargando productos...</p>
      </div>
    `;
  }

  // Map category name to gender param for API
  const genderMap = {
    'Mujeres': 'Mujeres',
    'Hombres': 'Hombres',
    'Niños': 'Niños'
  };
  const genderParam = genderMap[categoryName];

  try {
    let url = '/api/products?limit=24&page=0';
    if (genderParam) url += `&gender=${encodeURIComponent(genderParam)}`;

    const res = await fetchWithAuth(url);
    if (!res.ok) throw new Error('Failed to fetch');
    const data = await res.json();

    // Handle both old array response and new paginated response
    let products = Array.isArray(data) ? data : (data.products || []);
    const hasMore = Array.isArray(data) ? false : (data.hasMore || false);
    const total = Array.isArray(data) ? products.length : (data.total || products.length);

    // For "Lo más vendido" fall back to local filter
    if (categoryName === 'Lo más vendido') {
      await ensureProductsLoaded();
      products = allProducts.filter(p => p.is_bestseller === 1 || p.is_bestseller === '1' || p.is_bestseller === true);
    }

    // Sort bestsellers first
    products.sort((a, b) => {
      const aBest = (a.is_bestseller === 1 || a.is_bestseller === true || a.is_bestseller === '1') ? 1 : 0;
      const bBest = (b.is_bestseller === 1 || b.is_bestseller === true || b.is_bestseller === '1') ? 1 : 0;
      return bBest - aBest;
    });

    // Store for brand filtering
    categoryBaseProducts = products;
    categoryFilteredProducts = products;

    // Populate brand filter dropdown
    const brandSelect = document.getElementById('category-brand-select');
    if (brandSelect) {
      const brandsSet = new Set();
      products.forEach(p => { if (p.brand) brandsSet.add(p.brand.trim()); });
      const sortedBrands = Array.from(brandsSet).sort();
      let optionsHtml = '<option value="all">Todas las Marcas</option>';
      sortedBrands.forEach(b => { optionsHtml += `<option value="${b}">${b}</option>`; });
      brandSelect.innerHTML = optionsHtml;
      brandSelect.value = 'all';
    }

    // Render
    renderCategoryProducts();

    // Setup infinite scroll to load more pages from server
    if (hasMore && genderParam) {
      setupServerPaginationObserver(genderParam, 1, total);
    }

  } catch (err) {
    console.error(err);
    if (gridEl) {
      gridEl.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; padding: 48px; color: #ff3b30;">
          <p>Error al cargar productos. Intenta de nuevo.</p>
        </div>
      `;
    }
  }
};

// Infinite scroll that loads next pages from the server
function setupServerPaginationObserver(genderParam, nextPage, total) {
  const gridEl = document.getElementById('category-product-grid');
  if (!gridEl) return;

  const oldSentinel = document.getElementById('category-scroll-sentinel');
  if (oldSentinel) oldSentinel.remove();
  if (categoryScrollObserver) { categoryScrollObserver.disconnect(); categoryScrollObserver = null; }

  if (categoryBaseProducts.length >= total) return;

  const sentinel = document.createElement('div');
  sentinel.id = 'category-scroll-sentinel';
  sentinel.style.cssText = 'grid-column:1/-1; height:60px; display:flex; align-items:center; justify-content:center;';
  sentinel.innerHTML = '<span style="font-size:12px;color:#aaa;">Cargando más...</span>';
  gridEl.appendChild(sentinel);

  categoryScrollObserver = new IntersectionObserver(async (entries) => {
    if (!entries[0].isIntersecting) return;
    categoryScrollObserver.disconnect();
    sentinel.remove();

    try {
      const res = await fetchWithAuth(`/api/products?limit=24&page=${nextPage}&gender=${encodeURIComponent(genderParam)}`);
      if (!res.ok) return;
      const data = await res.json();
      const newProducts = Array.isArray(data) ? data : (data.products || []);
      const hasMore = Array.isArray(data) ? false : (data.hasMore || false);

      // Append to base products
      categoryBaseProducts = [...categoryBaseProducts, ...newProducts];
      categoryFilteredProducts = categoryBrandFilter === 'all'
        ? categoryBaseProducts
        : categoryBaseProducts.filter(p => p.brand === categoryBrandFilter);

      // Append new batch to grid
      appendCategoryProductBatch();

      if (hasMore) {
        setupServerPaginationObserver(genderParam, nextPage + 1, total);
      }
    } catch (err) {
      console.error('[Server pagination error]', err);
    }
  }, { rootMargin: '300px' });

  categoryScrollObserver.observe(sentinel);
}

window.showMainLanding = function() {
  currentSelectedCategory = null;
  categoryBrandFilter = 'all';

  const landingContainer = document.getElementById('main-landing-container');
  const catalogContainer = document.getElementById('category-catalog-container');
  if (landingContainer) landingContainer.style.display = 'block';
  if (catalogContainer) catalogContainer.style.display = 'none';

  // Show mobile search/filters bar only if on home tab
  const mobileBar = document.querySelector('.mobile-search-filters');
  if (mobileBar && currentTab === 'home') {
    mobileBar.classList.remove('hidden');
  }
};

function applyCategoryFilters(baseProducts) {
  if (baseProducts) {
    categoryBaseProducts = baseProducts;
  }
  
  if (categoryBrandFilter === 'all') {
    categoryFilteredProducts = categoryBaseProducts;
  } else {
    categoryFilteredProducts = categoryBaseProducts.filter(p => p.brand === categoryBrandFilter);
  }
  
  renderCategoryProducts();
}

window.filterCategoryByBrand = function(brand) {
  categoryBrandFilter = brand;
  applyCategoryFilters();
};

function renderCategoryProducts() {
  const gridEl = document.getElementById('category-product-grid');
  if (!gridEl) return;

  categoryCurrentPage = 0;

  // Remove existing sentinel
  const oldSentinel = document.getElementById('category-scroll-sentinel');
  if (oldSentinel) oldSentinel.remove();
  if (categoryScrollObserver) { categoryScrollObserver.disconnect(); categoryScrollObserver = null; }

  if (categoryFilteredProducts.length === 0) {
    gridEl.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 48px; color: var(--text-secondary);">
        <p>No se encontraron calzados que coincidan con tu selección.</p>
      </div>
    `;
    return;
  }

  if (window.innerWidth <= 768) {
    gridEl.innerHTML = `
      <div class="masonry-column masonry-column-left"></div>
      <div class="masonry-column masonry-column-right"></div>
    `;
  } else {
    gridEl.innerHTML = '';
  }

  appendCategoryProductBatch();
}

function appendCategoryProductBatch() {
  const gridEl = document.getElementById('category-product-grid');
  if (!gridEl) return;

  const start = categoryCurrentPage * PAGE_SIZE;
  const end = start + PAGE_SIZE;
  const batch = categoryFilteredProducts.slice(start, end);

  if (batch.length === 0) return;

  if (window.innerWidth <= 768) {
    const leftCol = gridEl.querySelector('.masonry-column-left');
    const rightCol = gridEl.querySelector('.masonry-column-right');
    batch.forEach((p, index) => {
      const cardHtml = buildProductCard(p);
      if (index % 2 === 0) {
        if (leftCol) leftCol.insertAdjacentHTML('beforeend', cardHtml);
      } else {
        if (rightCol) rightCol.insertAdjacentHTML('beforeend', cardHtml);
      }
    });
  } else {
    batch.forEach(p => {
      gridEl.insertAdjacentHTML('beforeend', buildProductCard(p));
    });
  }

  if (end < categoryFilteredProducts.length) {
    setupCategoryScrollObserver();
  }
}

function setupCategoryScrollObserver() {
  const gridEl = document.getElementById('category-product-grid');
  if (!gridEl) return;

  const sentinel = document.createElement('div');
  sentinel.id = 'category-scroll-sentinel';
  sentinel.style.height = '10px';
  sentinel.style.gridColumn = '1 / -1';
  gridEl.appendChild(sentinel);

  categoryScrollObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) {
      categoryCurrentPage++;
      sentinel.remove();
      appendCategoryProductBatch();
    }
  }, { rootMargin: '200px' });

  categoryScrollObserver.observe(sentinel);
}

window.scrollToCategories = function(event) {
  if (event) event.preventDefault();
  const target = document.getElementById('categories-section-anchor');
  if (target) {
    target.scrollIntoView({ behavior: 'smooth' });
  }
};

/* --- Global Mobile Slide-Up Search Logic --- */
window.toggleMobileSearch = function() {
  const overlay = document.getElementById('mobile-search-overlay');
  const sheet = document.getElementById('mobile-search-sheet');
  if (!overlay || !sheet) return;

  overlay.classList.toggle('active');
  sheet.classList.toggle('active');

  if (sheet.classList.contains('active')) {
    const input = document.getElementById('mobile-search-sheet-input');
    if (input) {
      input.value = '';
      setTimeout(() => input.focus(), 100);
    }
  }
};

/* ── Nav Search Dropdown ──────────────────────────────── */
window.toggleNavSearch = function() {
  const dropdown = document.getElementById('nav-search-dropdown');
  const toggleBtn = document.getElementById('nav-search-toggle');
  if (!dropdown) return;

  const isOpen = dropdown.classList.contains('open');
  if (isOpen) {
    closeNavSearch();
  } else {
    dropdown.classList.add('open');
    if (toggleBtn) toggleBtn.classList.add('open');
    const input = document.getElementById('nav-search-input');
    if (input) {
      input.value = '';
      setTimeout(() => input.focus(), 80);
    }
  }
};

window.closeNavSearch = function() {
  const dropdown = document.getElementById('nav-search-dropdown');
  const toggleBtn = document.getElementById('nav-search-toggle');
  if (dropdown) dropdown.classList.remove('open');
  if (toggleBtn) toggleBtn.classList.remove('open');
};

window.handleNavSearch = function(event) {
  if (event.key === 'Escape') {
    closeNavSearch();
    return;
  }
  const query = event.target.value.trim();
  if (event.key === 'Enter' && query.length > 0) {
    closeNavSearch();
    executeGlobalSearch(query);
    return;
  }
  if (query.length >= 2) {
    executeGlobalSearch(query);
  } else if (query.length === 0) {
    showMainLanding();
  }
};

// Cerrar dropdown al hacer click fuera
document.addEventListener('click', function(e) {
  const wrapper = document.getElementById('nav-search-wrapper');
  if (wrapper && !wrapper.contains(e.target)) {
    closeNavSearch();
  }
});

// Cerrar con Escape global
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeNavSearch();
});



window.executeGlobalSearch = async function(query) {
  currentSelectedCategory = 'Búsqueda';
  categoryBrandFilter = 'all';

  const path = window.location.pathname;
  const isIndex = path === '/' || path.includes('index.html') || path === '';
  if (!isIndex) {
    window.location.href = `/index.html?search=${encodeURIComponent(query)}`;
    return;
  }

  // If we are on index, switch to home tab
  if (typeof switchTab === 'function') {
    switchTab('home');
  }

  // Toggle sections visibility
  const landingContainer = document.getElementById('main-landing-container');
  const catalogContainer = document.getElementById('category-catalog-container');
  if (landingContainer) landingContainer.style.display = 'none';
  if (catalogContainer) catalogContainer.style.display = 'block';

  // Set category title
  const titleEl = document.getElementById('category-catalog-title');
  if (titleEl) titleEl.textContent = `Búsqueda: "${query}"`;

  // Show loading
  const gridEl = document.getElementById('category-product-grid');
  if (gridEl) gridEl.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:48px;color:var(--text-secondary);"><i class="fa-solid fa-spinner fa-spin" style="font-size:24px;margin-bottom:12px;"></i><p>Buscando...</p></div>`;

  // Hide mobile search/filters bar
  const mobileBar = document.querySelector('.mobile-search-filters');
  if (mobileBar) mobileBar.classList.add('hidden');

  try {
    const res = await fetchWithAuth(`/api/products?search=${encodeURIComponent(query)}&limit=48&page=0`);
    if (!res.ok) throw new Error('Search failed');
    const data = await res.json();
    const baseProducts = Array.isArray(data) ? data : (data.products || []);

    baseProducts.sort((a, b) => {
      const aBest = (a.is_bestseller === 1 || a.is_bestseller === true || a.is_bestseller === '1') ? 1 : 0;
      const bBest = (b.is_bestseller === 1 || b.is_bestseller === true || b.is_bestseller === '1') ? 1 : 0;
      return bBest - aBest;
    });

    const brandSelect = document.getElementById('category-brand-select');
    if (brandSelect) {
      const brandsSet = new Set();
      baseProducts.forEach(p => { if (p.brand) brandsSet.add(p.brand.trim()); });
      const sortedBrands = Array.from(brandsSet).sort();
      let optionsHtml = '<option value="all">Todas las Marcas</option>';
      sortedBrands.forEach(b => { optionsHtml += `<option value="${b}">${b}</option>`; });
      brandSelect.innerHTML = optionsHtml;
      brandSelect.value = 'all';
    }

    applyCategoryFilters(baseProducts);
  } catch (err) {
    console.error(err);
    if (gridEl) gridEl.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:48px;color:#ff3b30;"><p>Error al buscar productos.</p></div>`;
  }
};

window.handleMobileSheetSearch = function(event) {
  const query = event.target.value.trim();
  if (event.key === 'Enter') {
    if (!query) return;
    
    const path = window.location.pathname;
    const isIndex = path === '/' || path.includes('index.html') || path === '';
    
    if (!isIndex) {
      window.location.href = `/index.html?search=${encodeURIComponent(query)}`;
    } else {
      executeGlobalSearch(query);
      toggleMobileSearch();
    }
  } else {
    // Live search on home page if they type at least 2 characters
    const path = window.location.pathname;
    const isIndex = path === '/' || path.includes('index.html') || path === '';
    if (isIndex && query.length >= 2) {
      executeGlobalSearch(query);
    }
  }
};