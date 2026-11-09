# Shared by the VPS scripts. The order is the port order: each service's default port is 8710 plus its index.
ROOQ_SERVICES=(read-api relayer queue coordinator risk-a risk-b maker price-relay)
# The maker needs MAKER_TERMS and a funded shielded wallet, so it is enabled by hand once those exist.
ROOQ_DEFAULT_SERVICES=(read-api relayer queue coordinator risk-a risk-b price-relay)
ROOQ_PREFIX=/opt/rooq
ROOQ_ETC=/etc/rooq
