document.addEventListener('DOMContentLoaded', async () => {
    // Set current year in footer
    document.getElementById('currentYear').textContent = new Date().getFullYear();
    
    // Load ports and container types
    try {
        await loadPorts();
        await loadContainerTypes();
        console.log('Ports and container types loaded successfully');
    } catch (error) {
        console.error('Error during initial data loading:', error);
    }
    
    // Set up form submission
    const form = document.getElementById('calculatorForm');
    form.addEventListener('submit', handleFormSubmit);
});

// Load ports from API
async function loadPorts() {
    try {
        console.log('Fetching ports...');
        const response = await fetch('/api/ports');
        if (!response.ok) {
            throw new Error(`Failed to fetch ports: ${response.status} ${response.statusText}`);
        }
        
        const ports = await response.json();
        console.log(`Received ${ports.length} ports from server`);
        
        if (!Array.isArray(ports) || ports.length === 0) {
            console.warn('No ports received from server or invalid format');
            throw new Error('No ports available');
        }
        
        // Group ports by region
        const portsByRegion = {};
        ports.forEach(port => {
            if (!port.region) {
                port.region = 'Other'; // Default region if none specified
            }
            
            if (!portsByRegion[port.region]) {
                portsByRegion[port.region] = [];
            }
            portsByRegion[port.region].push(port);
        });
        
        // Populate origin and destination dropdowns
        const originSelect = document.getElementById('origin');
        const destinationSelect = document.getElementById('destination');
        
        if (!originSelect || !destinationSelect) {
            console.error('Port select elements not found in DOM');
            throw new Error('Port select elements not found');
        }
        
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
                originOption.textContent = `${port.name || 'Unknown'}, ${port.country || 'Unknown'} (${port.id})`;
                originGroup.appendChild(originOption);
                
                // Create option for destination
                const destinationOption = document.createElement('option');
                destinationOption.value = port.id;
                destinationOption.textContent = `${port.name || 'Unknown'}, ${port.country || 'Unknown'} (${port.id})`;
                destinationGroup.appendChild(destinationOption);
            });
            
            originSelect.appendChild(originGroup);
            destinationSelect.appendChild(destinationGroup);
        });
        
        console.log('Ports loaded successfully');
    } catch (error) {
        console.error('Error loading ports:', error);
        // Display error message on page instead of alert
        const errorElement = document.createElement('div');
        errorElement.className = 'alert alert-danger';
        errorElement.textContent = 'Failed to load ports. Please refresh the page and try again.';
        
        const formElement = document.getElementById('calculatorForm');
        if (formElement) {
            formElement.prepend(errorElement);
        }
        
        throw error; // Re-throw to handle in the calling function
    }
}

// Load container types from API
async function loadContainerTypes() {
    try {
        console.log('Fetching container types...');
        const response = await fetch('/api/container-types');
        if (!response.ok) {
            throw new Error(`Failed to fetch container types: ${response.status} ${response.statusText}`);
        }
        
        const containerTypes = await response.json();
        console.log(`Received ${containerTypes.length} container types from server`);
        
        if (!Array.isArray(containerTypes) || containerTypes.length === 0) {
            console.warn('No container types received from server or invalid format');
            // If no container types from API, use default ones
            console.log('Using default container types');
            useDefaultContainerTypes();
            return;
        }
        
        const containerTypeSelect = document.getElementById('containerType');
        
        if (!containerTypeSelect) {
            console.error('Container type select element not found in DOM');
            throw new Error('Container type select element not found');
        }
        
        // Clear existing options except the first one
        containerTypeSelect.innerHTML = '<option value="">Select container type</option>';
        
        // Add container types
        containerTypes.forEach(containerType => {
            const option = document.createElement('option');
            option.value = containerType.id;
            option.textContent = `${containerType.name} - ${containerType.description || ''}`;
            containerTypeSelect.appendChild(option);
        });
        
        console.log('Container types loaded successfully');
    } catch (error) {
        console.error('Error loading container types:', error);
        // Use default container types as fallback
        useDefaultContainerTypes();
        throw error; // Re-throw to handle in the calling function
    }
}

// Fallback function to use default container types
function useDefaultContainerTypes() {
    const defaultContainerTypes = [
        { id: '20DV', name: '20DV', description: '20ft Dry Van' },
        { id: '40DV', name: '40DV', description: '40ft Dry Van' },
        { id: '40HC', name: '40HC', description: '40ft High Cube' },
        { id: '45HC', name: '45HC', description: '45ft High Cube' }
    ];
    
    const containerTypeSelect = document.getElementById('containerType');
    
    if (!containerTypeSelect) {
        console.error('Container type select element not found in DOM');
        return;
    }
    
    // Clear existing options except the first one
    containerTypeSelect.innerHTML = '<option value="">Select container type</option>';
    
    // Add default container types
    defaultContainerTypes.forEach(containerType => {
        const option = document.createElement('option');
        option.value = containerType.id;
        option.textContent = `${containerType.name} - ${containerType.description}`;
        containerTypeSelect.appendChild(option);
    });
    
    console.log('Default container types loaded as fallback');
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
    
    // Clear any previous error messages
    const previousError = form.querySelector('.alert');
    if (previousError) {
        previousError.remove();
    }
    
    try {
        // Get form data
        const formData = new FormData(form);
        const data = {
            origin: formData.get('origin'),
            destination: formData.get('destination'),
            containerType: formData.get('containerType'),
            email: formData.get('email')
        };
        
        // Validate form data
        if (!data.origin || !data.destination || !data.containerType || !data.email) {
            throw new Error('Please fill in all required fields');
        }
        
        // Call API to calculate rate
        console.log('Sending calculation request:', data);
        const response = await fetch('/api/calculate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to calculate rate: ${response.status} ${response.statusText} - ${errorText}`);
        }
        
        const result = await response.json();
        console.log('Received calculation result:', result);
        
        // Display results
        displayResults(data, result);
    } catch (error) {
        console.error('Error during calculation:', error);
        
        // Display error message on page
        const errorElement = document.createElement('div');
        errorElement.className = 'alert alert-danger';
        errorElement.textContent = error.message || 'An error occurred while calculating the rate. Please try again.';
        
        form.prepend(errorElement);
        
        // Hide results if they were previously shown
        const resultContainer = document.getElementById('resultContainer');
        if (resultContainer) {
            resultContainer.classList.add('hidden');
        }
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
    
    if (!originOption || !destinationOption || !containerTypeOption) {
        console.error('Selected options not found');
        return;
    }
    
    // Update display elements
    document.getElementById('routeDisplay').textContent = 
        `${originOption.textContent.split(' (')[0]} → ${destinationOption.textContent.split(' (')[0]}`;
    document.getElementById('containerDisplay').textContent = containerTypeOption.textContent.split(' - ')[0];
    document.getElementById('dateDisplay').textContent = new Date().toLocaleDateString();
    
    document.getElementById('minRate').textContent = `$${result.min_rate || 0}`;
    document.getElementById('maxRate').textContent = `$${result.max_rate || 0}`;
    document.getElementById('avgRate').textContent = `$${result.rate || 0}`;
    
    // Calculate position of average rate indicator
    const range = (result.max_rate || 0) - (result.min_rate || 0);
    const position = range > 0 ? (((result.rate || 0) - (result.min_rate || 0)) / range) * 100 : 50;
    document.getElementById('rateIndicator').style.width = `${position}%`;
    
    document.getElementById('sourceCount').textContent = result.source_count || 0;
    
    // Display reliability as percentage
    const reliabilityPercent = Math.round((result.reliability || 0) * 100);
    document.getElementById('reliability').textContent = `${reliabilityPercent}%`;
    
    // Show result container
    const resultContainer = document.getElementById('resultContainer');
    resultContainer.classList.remove('hidden');
    
    // Scroll to results
    resultContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
