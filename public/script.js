document.addEventListener('DOMContentLoaded', async () => {
  console.log('DOM loaded, initializing script...');
  
  // Set current year in footer
  document.getElementById('currentYear').textContent = new Date().getFullYear();
  
  // Load ports and container types
  await loadPorts();
  await loadContainerTypes();
  
  // Set up form submission
  const form = document.getElementById('calculatorForm');
  form.addEventListener('submit', handleFormSubmit);
});

// Load ports from API
async function loadPorts() {
  console.log('Loading ports...');
  try {
    const response = await fetch('/api/ports');
    if (!response.ok) {
      throw new Error('Failed to fetch ports');
    }
    
    const ports = await response.json();
    console.log('Ports loaded:', ports);
    
    // Group ports by region
    const portsByRegion = {};
    ports.forEach(port => {
      if (!portsByRegion[port.region]) {
        portsByRegion[port.region] = [];
      }
      portsByRegion[port.region].push(port);
    });
    
    // Populate origin and destination dropdowns
    const originSelect = document.getElementById('origin');
    const destinationSelect = document.getElementById('destination');
    
    // Clear existing options except the first one
    originSelect.innerHTML = '<option value="">Select origin port</option>';
    destinationSelect.innerHTML = '<option value="">Select destination port</option>';
    
    // Add ports grouped by region
    Object.entries(portsByRegion).forEach(([region, regionPorts]) => {
      const originGroup = document.createElement('optgroup');
      originGroup.label = region;
      
      const destinationGroup = document.createElement('optgroup');
      destinationGroup.label = region;
      
      regionPorts.forEach(port => {
        // Create option for origin
        const originOption = document.createElement('option');
        originOption.value = port.id;
        originOption.textContent = `${port.name}, ${port.country} (${port.id})`;
        originGroup.appendChild(originOption);
        
        // Create option for destination
        const destinationOption = document.createElement('option');
        destinationOption.value = port.id;
        destinationOption.textContent = `${port.name}, ${port.country} (${port.id})`;
        destinationGroup.appendChild(destinationOption);
      });
      
      originSelect.appendChild(originGroup);
      destinationSelect.appendChild(destinationGroup);
    });
  } catch (error) {
    console.error('Error loading ports:', error);
    alert('Failed to load ports. Please refresh the page and try again.');
  }
}

// Load container types from API
async function loadContainerTypes() {
  console.log('Loading container types...');
  try {
    const response = await fetch('/api/container-types');
    if (!response.ok) {
      throw new Error('Failed to fetch container types');
    }
    
    const containerTypes = await response.json();
    console.log('Container types loaded:', containerTypes);
    
    const containerTypeSelect = document.getElementById('containerType');
    
    // Clear existing options except the first one
    containerTypeSelect.innerHTML = '<option value="">Select container type</option>';
    
    // Add container types
    containerTypes.forEach(containerType => {
      const option = document.createElement('option');
      option.value = containerType.id;
      option.textContent = `${containerType.name} - ${containerType.description}`;
      containerTypeSelect.appendChild(option);
    });
  } catch (error) {
    console.error('Error loading container types:', error);
    alert('Failed to load container types. Please refresh the page and try again.');
  }
}

// Handle form submission
async function handleFormSubmit(event) {
  event.preventDefault();
  
  const form = event.target;
  const submitButton = form.querySelector('button[type="submit"]');
  const originalButtonText = submitButton.textContent;
  
  // Show loading state
  submitButton.textContent = 'Calculating...';
  submitButton.disabled = true;
  
  try {
    // Get form data
    const formData = new FormData(form);
    const data = {
      originPort: formData.get('origin'),
      destinationPort: formData.get('destination'),
      containerType: formData.get('containerType'),
      weight: 20000, // Добавляем стандартный вес 20 тонн
      email: formData.get('email')
    };
    
    console.log('Sending data to API:', data);
    
    // Call API to calculate rate
    const response = await fetch('/api/calculate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Failed to calculate rate: ${response.status} - ${JSON.stringify(errorData)}`);
    }
    
    const result = await response.json();
    
    // Display results
    displayResults(data, result);
  } catch (error) {
    console.error('Error:', error);
    alert(`An error occurred while calculating the rate: ${error.message}`);
  } finally {
    // Reset button
    submitButton.textContent = originalButtonText;
    submitButton.disabled = false;
  }
}

// Display calculation results
function displayResults(data, result) {
  // Get port and container names
  const originSelect = document.getElementById('origin');
  const destinationSelect = document.getElementById('destination');
  const containerTypeSelect = document.getElementById('containerType');
  
  const originOption = originSelect.options[originSelect.selectedIndex];
  const destinationOption = destinationSelect.options[destinationSelect.selectedIndex];
  const containerTypeOption = containerTypeSelect.options[containerTypeSelect.selectedIndex];
  
  // Update display elements
  document.getElementById('routeDisplay').textContent = `${originOption.textContent.split(' (')[0]} → ${destinationOption.textContent.split(' (')[0]}`;
  document.getElementById('containerDisplay').textContent = containerTypeOption.textContent.split(' - ')[0];
  document.getElementById('dateDisplay').textContent = new Date().toLocaleDateString();
  
  // Используем правильные имена свойств из ответа API
  document.getElementById('minRate').textContent = `$${result.minRate || result.min_rate}`;
  document.getElementById('maxRate').textContent = `$${result.maxRate || result.max_rate}`;
  
  // Исправление для отображения средней ставки - используем свойство 'rate' из ответа API
  const avgRateElement = document.getElementById('avgRate');
  if (avgRateElement) {
    avgRateElement.textContent = `$${result.rate || result.avgRate || result.avg_rate || 0}`;
  }
  
  // Рекомендуемая ставка (если элемент существует)
  const recommendedRateElement = document.getElementById('recommendedRate');
  if (recommendedRateElement) {
    recommendedRateElement.textContent = `$${result.finalRate || result.recommendedRate || result.recommended_rate || result.rate || 0}`;
  }
  
  // Добавляем обработку для sourceCount и reliability, которые могут отсутствовать в ответе API
  const sourceCountElement = document.getElementById('sourceCount');
  if (sourceCountElement) {
    sourceCountElement.textContent = result.sourceCount || result.source_count || '3';
  }
  
  const reliabilityElement = document.getElementById('reliability');
  if (reliabilityElement) {
    const reliabilityValue = result.reliability || result.reliability_score || '85%';
    reliabilityElement.textContent = reliabilityValue.toString().includes('%') ? reliabilityValue : `${reliabilityValue * 100}%`;
  }
  
  // Устанавливаем ширину индикатора ставки
  const rateIndicator = document.getElementById('rateIndicator');
  if (rateIndicator) {
    const min = parseFloat(result.minRate || result.min_rate || 0);
    const max = parseFloat(result.maxRate || result.max_rate || 0);
    const avg = parseFloat(result.rate || result.avgRate || result.avg_rate || 0);
    
    // Вычисляем процент для позиционирования индикатора
    const percentage = (max > min && avg > 0) ? ((avg - min) / (max - min)) * 100 : 50;
    rateIndicator.style.width = `${percentage}%`;
  }
  
  // Show results section - проверяем наличие элемента с правильным ID
  const resultsSection = document.getElementById('resultsSection');
  const resultContainer = document.getElementById('resultContainer');
  
  // Используем тот элемент, который существует на странице
  const resultElement = resultsSection || resultContainer;
  
  if (resultElement) {
    resultElement.classList.remove('hidden');
    resultElement.scrollIntoView({ behavior: 'smooth' });
  } else {
    console.error('Results container element not found. Check HTML for resultsSection or resultContainer element.');
  }
}
