export class ProviderRegistry {
    constructor() {
        this.providers = [];
    }

    register(provider) {
        this.providers.push(provider);
        return this;
    }

    all() {
        return [...this.providers];
    }

    resolveById(id) {
        return this.providers.find((provider) => provider.id === id) || null;
    }

    resolveByUrl(inputUrl) {
        return this.providers.find((provider) => provider.supports(inputUrl)) || null;
    }
}

export default ProviderRegistry;
