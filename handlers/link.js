function init(hub) {
    async function linkAccount(interaction, code) {
        const discordId = interaction.user.id;
        await interaction.deferReply({ flags: 64 });

        let result;
        try {
            result = await hub.api('POST', '/tradebot/link-verify', { discord_id: discordId, code });
        } catch (err) {
            if (err.status === 400) {
                return interaction.editReply('❌ Invalid or expired code. Run `!link` in Minecraft to get a new one.');
            }
            throw err;
        }

        if (result.updated) {
            await interaction.editReply('✅ Account updated! Your Minecraft and Discord accounts are now re-linked.');
        } else {
            await interaction.editReply('✅ Accounts linked! Your Minecraft and Discord trade history will now be combined.');
        }
    }

    return { linkAccount };
}

module.exports = init;
