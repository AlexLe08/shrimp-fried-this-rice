import { SlashCommandBuilder } from 'discord.js';

export default {
    data: new SlashCommandBuilder()
        .setName('info')
        .setDescription('Get info about a user or a server!')
        .addSubcommand( (subcommand) => {
            return subcommand
                .setName('user')
                .setDescription('Get info about a user!')
                .addUserOption( (option) => {
                    return option
                        .setName('target')
                        .setDescription('The user')
                })
        })
        .addSubcommand( (subcommand) => {
            return subcommand
                .setName('server')
                .setDescription('Get info about the server!')
        })
        ,
}